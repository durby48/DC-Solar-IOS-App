import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  Confetti,
  EmptyState,
  FadeInUp,
  Pill,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { getDocumentUrl } from '@/lib/data';
import { haptics } from '@/lib/haptics';
import { shareDocument, viewDocument } from '@/lib/pdf';
import { formatShortDate, todayISO } from '@/lib/dates';
import {
  deleteFinanceEntry,
  duplicateDocument,
  fetchEntryRevisions,
  fetchJobFinanceEntries,
  recordPayment,
  revisionStoragePath,
  splitPayment,
  updateFinanceEntry,
  type EntryRevision,
  type FinanceEntry,
  type SplitAllocation,
} from '@/lib/documents';
import { fetchPipelineJobs } from '@/lib/pipeline';
import { type Job } from '@/lib/types';
import { isValidISODate } from '@/lib/time';

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function entryIcon(entry: FinanceEntry): keyof typeof Ionicons.glyphMap {
  if (entry.type === 'invoice') return 'receipt';
  if (entry.type === 'estimate') return 'calculator';
  if (entry.type === 'contract') return 'document-text';
  if (entry.type === 'payment') return 'cash';
  if (entry.type === 'investment') return 'trending-up';
  return 'pricetag';
}

/** Money in is green, money out is coral, paperwork stays ink. */
function amountColor(entry: FinanceEntry): string {
  // Investment is money in, same as a payment — it just isn't revenue.
  if (entry.type === 'payment' || entry.type === 'investment') return colors.mintDeep;
  if (entry.type === 'expense') return colors.coralDeep;
  return colors.textPrimary;
}

function entryTitle(entry: FinanceEntry): string {
  // The document NUMBER never changes across revisions — the revision counter
  // is what tells two versions of DC-26012-Estimate apart.
  const rev = (entry.revision ?? 1) > 1 ? ` · rev ${entry.revision}` : '';
  if (entry.type === 'invoice') return `${entry.document_number ?? 'Invoice'}${rev}`;
  if (entry.type === 'estimate') return `${entry.document_number ?? 'Estimate'}${rev}`;
  if (entry.type === 'contract') return entry.description ?? 'Contract signed';
  if (entry.type === 'payment') return 'Payment';
  if (entry.type === 'investment') return entry.description ?? 'Investment';
  return entry.description ?? 'Expense';
}

/**
 * Is this row a real DOCUMENT — something with line items and a PDF to
 * re-render — as opposed to a payment, an expense, an owner contribution or
 * the document-less "Contract value" adjustment row? Only documents open in
 * the builder; everything else keeps the inline amount/date/description editor.
 */
function isRevisable(entry: FinanceEntry): boolean {
  return (
    (entry.type === 'estimate' || entry.type === 'invoice') && entry.document_number != null
  );
}

function isStale(entry: FinanceEntry): boolean {
  return entry.document_meta?.pdf_state === 'stale';
}

/**
 * Admin-only "Invoices & estimates" card for a job: lists finance entries
 * of type invoice/estimate/payment (plus a collapsible expenses subsection),
 * with buttons to create new documents and to record a payment. Rows can be
 * edited inline (amount / date / description) and deleted with a two-tap
 * confirm — both admin-only via RLS (needs the finance-entries migration).
 * The parent must gate rendering on isAdmin; pass
 * `onEntriesChanged` so sibling finance summaries can refresh after edits.
 *
 * 2026-08-22 restyle: the kit's `Card` / `Button` / `Chip` / `Pill` /
 * `EmptyState` / `SkeletonList` replace the local card, sun-button, chip and
 * placeholder styles. Money recorded is now CELEBRATED — a payment that saves
 * fires a success haptic and a confetti burst at the Record payment control,
 * which is the third of the three moments the design calls worth marking
 * (clock-in, job → Complete, payment recorded). Saving an inline revision,
 * duplicating an estimate as an invoice and splitting a deposit each get the
 * success haptic without the confetti — they matter, but not that much.
 * Every flow, validation and RLS assumption is unchanged.
 */
export function JobInvoices({
  job,
  onEntriesChanged,
}: {
  job: Job;
  onEntriesChanged?: () => void;
}) {
  const [entries, setEntries] = useState<FinanceEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [paymentInputOpen, setPaymentInputOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [savingPayment, setSavingPayment] = useState(false);
  // One-shot confetti burst after a payment is recorded.
  const [celebrating, setCelebrating] = useState(false);
  // Inline row editing (admin corrections).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  // Two-tap delete confirm (works on native and web alike).
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sharingId, setSharingId] = useState<string | null>(null);
  const [expensesOpen, setExpensesOpen] = useState(false);
  // Splitting one ACH deposit across several jobs.
  const [splitId, setSplitId] = useState<string | null>(null);
  const [splitRows, setSplitRows] = useState<{ jobId: string | null; amount: string }[]>([]);
  const [splitJobs, setSplitJobs] = useState<{ id: string; label: string }[]>([]);
  const [savingSplit, setSavingSplit] = useState(false);
  // Revision history (admin SELECT only; empty when the table isn't readable).
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [history, setHistory] = useState<EntryRevision[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchJobFinanceEntries(job.id);
    if (result.status === 'ok') {
      setEntries(result.entries);
      setState('ok');
    } else {
      setEntries([]);
      setState('unavailable');
    }
  }, [job.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Investment sits with the money-in rows rather than the expenses below —
  // it is capital the owners put in, not a cost of the job.
  const listRows = entries.filter(
    (e) =>
      e.type === 'invoice' ||
      e.type === 'estimate' ||
      e.type === 'contract' ||
      e.type === 'payment' ||
      e.type === 'investment',
  );
  const expenses = entries.filter((e) => e.type === 'expense');
  const invoiced = entries
    .filter((e) => e.type === 'invoice')
    .reduce((sum, e) => sum + e.amount, 0);
  const paid = entries.filter((e) => e.type === 'payment').reduce((sum, e) => sum + e.amount, 0);
  const defaultPayment = Math.max(0, invoiced - paid);

  // `entry.revision` rides along as a cache-buster: a revision overwrites the
  // same storage object, and both the CDN and Safari will otherwise serve the
  // bytes they cached under the previous signed URL.
  const openEntry = async (entry: FinanceEntry) => {
    if (!entry.document_path) return;
    const url = await getDocumentUrl(entry.document_path, entry.revision);
    if (!url || !(await viewDocument(url))) {
      setStatus({ kind: 'error', message: 'Could not open the document. Please try again.' });
    }
  };

  const shareEntry = async (entry: FinanceEntry) => {
    if (!entry.document_path) return;
    setSharingId(entry.id);
    try {
      const url = await getDocumentUrl(entry.document_path, entry.revision);
      const fileName = `${entry.document_number ?? 'document'}.pdf`;
      if (!url || !(await shareDocument(url, fileName))) {
        setStatus({ kind: 'error', message: 'Could not share the document. Please try again.' });
      }
    } finally {
      setSharingId(null);
    }
  };

  /**
   * Open one archived revision.
   *
   * revise_document() snapshots a pre-existing document as its own revision 1,
   * and all it has to record is the LIVING path — which by then serves the
   * newest bytes. So when a superseded revision points at the living object,
   * prefer the archive copy we know uploadRevisionPdf() made
   * (`revisions/<docnum>-r<N>.pdf`). If that object never existed the browser
   * shows a 404, which beats quietly handing somebody rev 3 labelled rev 1.
   */
  const openRevision = async (entry: FinanceEntry, revision: EntryRevision) => {
    const stored = revision.document_path;
    if (!stored) {
      setStatus({ kind: 'error', message: 'That revision has no stored PDF.' });
      return;
    }
    const supersededLivingPath =
      stored === entry.document_path && revision.revision < (entry.revision ?? 1);
    const path =
      supersededLivingPath && revision.document_number
        ? revisionStoragePath(job.id, revision.document_number, revision.revision)
        : stored;
    const url = await getDocumentUrl(path, revision.revision);
    if (!url || !(await viewDocument(url))) {
      setStatus({ kind: 'error', message: 'Could not open that revision.' });
    }
  };

  const toggleHistory = async (entry: FinanceEntry) => {
    if (historyId === entry.id) {
      setHistoryId(null);
      return;
    }
    setStatus(null);
    setHistoryId(entry.id);
    setHistory([]);
    setHistoryLoading(true);
    const rows = await fetchEntryRevisions(entry.id);
    setHistoryLoading(false);
    setHistory(rows);
  };

  /** Estimate → invoice without retyping a single line. */
  const duplicateAsInvoice = async (entry: FinanceEntry) => {
    setStatus(null);
    setDuplicatingId(entry.id);
    const result = await duplicateDocument({ sourceEntryId: entry.id, asType: 'invoice' });
    setDuplicatingId(null);
    if (!result.ok) {
      setStatus({ kind: 'error', message: result.message });
      return;
    }
    haptics.success();
    await load();
    onEntriesChanged?.();
    router.push({
      pathname: '/document-builder',
      params: { jobId: job.id, entryId: result.entryId },
    });
  };

  const openBuilder = (entry: FinanceEntry) => {
    router.push({
      pathname: '/document-builder',
      params: { jobId: job.id, entryId: entry.id },
    });
  };

  const startSplit = async (entry: FinanceEntry) => {
    setStatus(null);
    setEditingId(null);
    setConfirmDeleteId(null);
    setSplitId(entry.id);
    setSplitRows([
      { jobId: null, amount: '' },
      { jobId: null, amount: '' },
    ]);
    if (splitJobs.length === 0) {
      const { jobs } = await fetchPipelineJobs();
      setSplitJobs(jobs.map((j) => ({ id: j.id, label: j.job_number ?? j.name })));
    }
  };

  const saveSplit = async (entry: FinanceEntry) => {
    const allocations: SplitAllocation[] = splitRows
      .filter((row) => row.jobId)
      .map((row) => ({
        jobId: row.jobId as string,
        label: splitJobs.find((j) => j.id === row.jobId)?.label ?? 'Job',
        amount: Number(row.amount.replace(/[^0-9.]/g, '')) || 0,
      }))
      .filter((a) => a.amount > 0);
    if (allocations.length === 0) {
      setStatus({ kind: 'error', message: 'Pick a job and enter an amount for at least one row.' });
      return;
    }
    setSavingSplit(true);
    const result = await splitPayment(entry.id, allocations);
    setSavingSplit(false);
    if (result.ok) {
      setSplitId(null);
      haptics.success();
      setStatus({
        kind: 'success',
        message:
          result.remainder > 0
            ? `Split across ${result.legs} jobs. ${formatMoney(result.remainder)} left unassigned on this job.`
            : `Split across ${result.legs} jobs.`,
      });
      await load();
      onEntriesChanged?.();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const startEdit = (entry: FinanceEntry) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(entry.id);
    setEditAmount(entry.amount > 0 ? String(entry.amount) : '');
    setEditDate(entry.occurred_on ?? '');
    setEditDescription(entry.description ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
  };

  const saveEdit = async (entry: FinanceEntry) => {
    const amount = Number(editAmount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const date = editDate.trim();
    if (date !== '' && !isValidISODate(date)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-07-24).' });
      return;
    }
    setSavingEdit(true);
    setStatus(null);
    const description = editDescription.trim();
    const result = await updateFinanceEntry(entry.id, {
      amount,
      occurred_on: date === '' ? null : date,
      description: description === '' ? null : description,
    });
    setSavingEdit(false);
    if (result.ok) {
      setEditingId(null);
      haptics.success();
      setStatus({ kind: 'success', message: 'Entry updated.' });
      await load();
      onEntriesChanged?.();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const pressDelete = async (entry: FinanceEntry) => {
    if (confirmDeleteId !== entry.id) {
      setStatus(null);
      setConfirmDeleteId(entry.id);
      return;
    }
    setConfirmDeleteId(null);
    setDeletingId(entry.id);
    const result = await deleteFinanceEntry(entry.id);
    setDeletingId(null);
    if (result.ok) {
      if (editingId === entry.id) setEditingId(null);
      setStatus({ kind: 'success', message: 'Entry deleted.' });
      await load();
      onEntriesChanged?.();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const savePayment = async (raw: string) => {
    const amount = Number(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(amount) || amount <= 0) {
      setStatus({ kind: 'error', message: 'Enter a payment amount greater than zero.' });
      return;
    }
    setSavingPayment(true);
    setStatus(null);
    const result = await recordPayment({
      amount,
      counterparty: job.customer?.name ?? 'Customer',
      occurredOn: todayISO(),
      jobId: job.id,
      customerId: job.customer_id,
    });
    setSavingPayment(false);
    if (result.ok) {
      setPaymentInputOpen(false);
      setPaymentAmount('');
      // Money in the door is worth a buzz and a burst.
      haptics.success();
      setCelebrating(true);
      setStatus({ kind: 'success', message: `Payment of ${formatMoney(amount)} recorded.` });
      load();
    } else {
      setStatus({ kind: 'error', message: `Could not record the payment: ${result.message}` });
    }
  };

  const promptPayment = () => {
    setStatus(null);
    const suggested = defaultPayment > 0 ? defaultPayment.toFixed(2) : '';
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Record payment',
        'Amount received from the customer.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Record', onPress: (value?: string) => savePayment(value ?? '') },
        ],
        'plain-text',
        suggested,
        'decimal-pad',
      );
    } else {
      setPaymentAmount(suggested);
      setPaymentInputOpen(true);
    }
  };

  const newDocument = (type: 'invoice' | 'estimate') => {
    router.push({ pathname: '/document-builder', params: { jobId: job.id, type } });
  };

  const renderEntryRow = (entry: FinanceEntry, index: number) => {
    const confirming = confirmDeleteId === entry.id;
    const busyDelete = deletingId === entry.id;
    const editing = editingId === entry.id;
    const revisable = isRevisable(entry);
    return (
      <FadeInUp key={entry.id} index={index}>
        <View style={index > 0 ? styles.rowBorderTop : undefined}>
          <AnimatedPressable
            onPress={() => openEntry(entry)}
            haptic={entry.document_path ? 'tapLight' : undefined}
            scaleTo={0.995}
            accessibilityRole="button"
            accessibilityLabel={entryTitle(entry)}
            style={styles.row}>
            <View style={styles.iconWrap}>
              <Ionicons name={entryIcon(entry)} size={18} color={colors.accentPrimary} />
            </View>
            <View style={styles.rowBody}>
              <AppText variant="bodyStrong" numberOfLines={1}>
                {entryTitle(entry)}
              </AppText>
              <View style={styles.metaRow}>
                {entry.status ? (
                  <Pill
                    label={entry.status}
                    bg={colors.sunLight}
                    fg={colors.ink}
                    textStyle={styles.capitalize}
                  />
                ) : null}
                {isStale(entry) ? (
                  <Chip
                    label={entry.document_path ? 'PDF out of date' : 'No PDF yet'}
                    tone="sun"
                    icon="warning"
                  />
                ) : null}
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {formatShortDate(entry.occurred_on)}
                </AppText>
              </View>
            </View>
            {/* Amount and the action buttons share a right-hand column, stacked.
                They used to sit inline with the date, which let five-figure
                amounts collide with the recorded date on narrow phones. */}
            <View style={styles.rowRight}>
              <AppText
                variant="bodyStrong"
                color={amountColor(entry)}
                numberOfLines={1}
                style={styles.amountText}>
                {formatMoney(entry.amount)}
              </AppText>
              <View style={styles.actionRow}>
                {entry.document_path ? (
                  <AnimatedPressable
                    onPress={() => void shareEntry(entry)}
                    disabled={sharingId !== null}
                    haptic="tapLight"
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Share document"
                    style={styles.iconButton}>
                    {sharingId === entry.id ? (
                      <ActivityIndicator size="small" color={colors.accentPrimary} />
                    ) : (
                      <Ionicons name="share-outline" size={15} color={colors.accentPrimary} />
                    )}
                  </AnimatedPressable>
                ) : null}
                {entry.type === 'payment' ? (
                  <AnimatedPressable
                    onPress={() => (splitId === entry.id ? setSplitId(null) : void startSplit(entry))}
                    haptic="tapLight"
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Split this payment across jobs"
                    style={styles.iconButton}>
                    <Ionicons name="git-branch" size={15} color={colors.accentPrimary} />
                  </AnimatedPressable>
                ) : null}
                {revisable && (entry.revision ?? 1) > 1 ? (
                  <AnimatedPressable
                    onPress={() => void toggleHistory(entry)}
                    haptic="tapLight"
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Revision history"
                    style={styles.iconButton}>
                    <Ionicons name="time-outline" size={15} color={colors.accentPrimary} />
                  </AnimatedPressable>
                ) : null}
                {entry.type === 'estimate' && entry.document_number ? (
                  <AnimatedPressable
                    onPress={() => void duplicateAsInvoice(entry)}
                    disabled={duplicatingId !== null}
                    haptic="tapMedium"
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel="Duplicate as invoice"
                    style={styles.iconButton}>
                    {duplicatingId === entry.id ? (
                      <ActivityIndicator size="small" color={colors.accentPrimary} />
                    ) : (
                      <Ionicons name="copy-outline" size={15} color={colors.accentPrimary} />
                    )}
                  </AnimatedPressable>
                ) : null}
                {/* Documents go to the builder, where the line items, the notes
                    and the PDF all move together. Payments, expenses,
                    investments and the document-less "Contract value" row have
                    nothing to re-render, so they keep the inline editor. */}
                <AnimatedPressable
                  onPress={() =>
                    revisable ? openBuilder(entry) : editing ? cancelEdit() : startEdit(entry)
                  }
                  haptic="tapLight"
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel="Edit entry"
                  style={styles.iconButton}>
                  <Ionicons name="pencil" size={15} color={colors.accentPrimary} />
                </AnimatedPressable>
                <AnimatedPressable
                  onPress={() => void pressDelete(entry)}
                  disabled={busyDelete}
                  haptic="tapLight"
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={confirming ? 'Confirm delete' : 'Delete entry'}
                  style={[styles.iconButton, confirming && styles.iconButtonDanger]}>
                  {busyDelete ? (
                    <ActivityIndicator size="small" color={colors.danger} />
                  ) : (
                    <Ionicons
                      name="trash"
                      size={15}
                      color={confirming ? colors.white : colors.textMuted}
                    />
                  )}
                </AnimatedPressable>
              </View>
            </View>
          </AnimatedPressable>
          {confirming ? (
            <AppText
              variant="caption"
              align="right"
              color={colors.danger}
              style={styles.confirmHint}>
              Tap the trash again to delete this entry.
            </AppText>
          ) : null}
          {historyId === entry.id ? (
            <Card tone="sunk" style={styles.editCard}>
              <AppText variant="heading">Revision history</AppText>
              {historyLoading ? (
                <SkeletonList count={2} height={20} radius={radii.sm} />
              ) : history.length === 0 ? (
                <AppText variant="caption" color={colors.textMuted}>
                  No archived revisions yet — this document was written before revisions were
                  tracked.
                </AppText>
              ) : (
                history.map((revision) => (
                  <View key={revision.id} style={styles.historyRow}>
                    <AppText variant="caption" numberOfLines={1} style={styles.historyText}>
                      rev {revision.revision} · {formatShortDate(revision.occurred_on)} ·{' '}
                      {formatMoney(revision.amount)}
                    </AppText>
                    {revision.document_path ? (
                      <AnimatedPressable
                        onPress={() => void openRevision(entry, revision)}
                        haptic="tapLight"
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`View revision ${revision.revision}`}>
                        <AppText variant="caption" color={colors.accentLink}>
                          view
                        </AppText>
                      </AnimatedPressable>
                    ) : (
                      <AppText variant="caption" color={colors.textMuted}>
                        no PDF
                      </AppText>
                    )}
                  </View>
                ))
              )}
            </Card>
          ) : null}
          {splitId === entry.id ? (
            <Card tone="sunk" style={styles.editCard}>
              <AppText variant="heading">Split {formatMoney(entry.amount)} across jobs</AppText>
              <AppText variant="caption" color={colors.textMuted} style={styles.splitHint}>
                For an ACH deposit covering several invoices. Amounts are yours to set — they
                don&apos;t have to match the invoiced figures.
              </AppText>
              {splitRows.map((row, index) => (
                <View key={index} style={styles.splitRow}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={styles.splitChips}>
                      {splitJobs.map((option) => (
                        <Chip
                          key={option.id}
                          label={option.label}
                          tone="olive"
                          selected={row.jobId === option.id}
                          onPress={() =>
                            setSplitRows((rows) =>
                              rows.map((r, i) => (i === index ? { ...r, jobId: option.id } : r)),
                            )
                          }
                        />
                      ))}
                    </View>
                  </ScrollView>
                  <TextInput
                    style={styles.input}
                    value={row.amount}
                    onChangeText={(text) =>
                      setSplitRows((rows) =>
                        rows.map((r, i) => (i === index ? { ...r, amount: text } : r)),
                      )
                    }
                    placeholder="0.00"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                  />
                </View>
              ))}
              {(() => {
                const allocated = splitRows.reduce(
                  (sum, r) => sum + (Number(r.amount.replace(/[^0-9.]/g, '')) || 0),
                  0,
                );
                const left = Math.round((entry.amount - allocated) * 100) / 100;
                return (
                  <AppText
                    variant="caption"
                    align="right"
                    color={left < 0 ? colors.danger : colors.textSecondary}>
                    {left < 0
                      ? `Over by ${formatMoney(Math.abs(left))}`
                      : `${formatMoney(allocated)} assigned · ${formatMoney(left)} left`}
                  </AppText>
                );
              })()}
              <View style={styles.editButtons}>
                <Button
                  label="+ Add job"
                  onPress={() => setSplitRows((rows) => [...rows, { jobId: null, amount: '' }])}
                  variant="ghost"
                  size="sm"
                />
                <Button
                  label="Cancel"
                  onPress={() => setSplitId(null)}
                  variant="ghost"
                  size="sm"
                  disabled={savingSplit}
                />
                <Button
                  label="Split"
                  onPress={() => void saveSplit(entry)}
                  loading={savingSplit}
                  size="sm"
                />
              </View>
            </Card>
          ) : null}
          {editing ? (
            <Card tone="sunk" style={styles.editCard}>
              <AppText variant="section" color={colors.textMuted}>
                Amount ($)
              </AppText>
              <TextInput
                style={styles.input}
                value={editAmount}
                onChangeText={setEditAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
              />
              <AppText variant="section" color={colors.textMuted}>
                Date (YYYY-MM-DD)
              </AppText>
              <TextInput
                style={styles.input}
                value={editDate}
                onChangeText={setEditDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <AppText variant="section" color={colors.textMuted}>
                Description
              </AppText>
              <TextInput
                style={styles.input}
                value={editDescription}
                onChangeText={setEditDescription}
                placeholder="Description"
                placeholderTextColor={colors.textMuted}
              />
              <View style={styles.editButtons}>
                <Button
                  label="Cancel"
                  onPress={cancelEdit}
                  variant="ghost"
                  size="sm"
                  disabled={savingEdit}
                />
                <Button
                  label="Save"
                  onPress={() => void saveEdit(entry)}
                  loading={savingEdit}
                  size="sm"
                />
              </View>
            </Card>
          ) : null}
        </View>
      </FadeInUp>
    );
  };

  return (
    <>
      <SectionHeader
        title="Invoices, estimates & payments"
        icon="receipt"
        style={styles.section}
      />
      {state === 'loading' ? (
        <SkeletonList count={3} height={72} />
      ) : state === 'unavailable' ? (
        <EmptyState
          icon="receipt"
          title="Invoices aren't available right now"
          body="The finance tables couldn't be read. Pull down to retry, or check you're signed in as an admin."
        />
      ) : listRows.length === 0 ? (
        <EmptyState
          icon="receipt"
          title="No invoices or estimates yet"
          body="Build the first estimate or invoice for this job with the buttons below."
        />
      ) : (
        <Card padded={false}>{listRows.map(renderEntryRow)}</Card>
      )}

      {state === 'ok' && expenses.length > 0 ? (
        <>
          <Button
            label={
              expensesOpen
                ? `Hide expenses (${expenses.length})`
                : `Show expenses (${expenses.length})`
            }
            onPress={() => setExpensesOpen((open) => !open)}
            variant="ghost"
            size="sm"
            icon={expensesOpen ? 'chevron-down' : 'chevron-forward'}
            style={styles.inlineButton}
          />
          {expensesOpen ? <Card padded={false}>{expenses.map(renderEntryRow)}</Card> : null}
        </>
      ) : null}

      <View style={styles.buttonRow}>
        <Button
          label="New estimate"
          onPress={() => newDocument('estimate')}
          icon="calculator"
          style={styles.grow}
        />
        <Button
          label="New invoice"
          onPress={() => newDocument('invoice')}
          icon="receipt"
          style={styles.grow}
        />
      </View>

      {/* The confetti mounts inside this block so the burst lands on the
          control the person just used, the way it lands on the clock card. */}
      <View style={styles.paymentZone}>
        {paymentInputOpen ? (
          <Card style={styles.paymentCard}>
            <AppText variant="section" color={colors.textMuted}>
              Payment amount ($)
            </AppText>
            <View style={styles.paymentRow}>
              <TextInput
                style={[styles.input, styles.grow]}
                value={paymentAmount}
                onChangeText={setPaymentAmount}
                placeholder="0.00"
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
              />
              <Button
                label="Record"
                onPress={() => savePayment(paymentAmount)}
                loading={savingPayment}
              />
              <Button
                label="Cancel"
                onPress={() => setPaymentInputOpen(false)}
                variant="ghost"
                size="sm"
              />
            </View>
          </Card>
        ) : (
          <Button
            label="Record payment"
            onPress={promptPayment}
            variant="secondary"
            icon="cash"
            loading={savingPayment}
            fullWidth
          />
        )}

        {celebrating ? <Confetti onDone={() => setCelebrating(false)} /> : null}
      </View>

      {status ? (
        <AppText
          variant="caption"
          align="center"
          color={status.kind === 'error' ? colors.danger : colors.success}>
          {status.message}
        </AppText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  capitalize: {
    textTransform: 'capitalize',
  },
  rowRight: {
    alignItems: 'flex-end',
    flexShrink: 0,
    gap: spacing.xs + 2,
  },
  amountText: {
    fontVariant: ['tabular-nums'],
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  confirmHint: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: colors.surface,
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  historyText: {
    flexShrink: 1,
  },
  splitHint: {
    marginBottom: spacing.xs,
  },
  splitRow: {
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  splitChips: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  editCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    gap: spacing.xs,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.textPrimary,
    ...typography.body,
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  inlineButton: {
    paddingHorizontal: 0,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  grow: {
    flexGrow: 1,
    flexShrink: 1,
  },
  paymentZone: {
    // Wraps the Record payment control so the confetti's `absoluteFill` has a
    // box to burst FROM — the same trick the clock card uses, which is why the
    // shards appear at the thing you just tapped rather than at the top of a
    // very long job screen.
    gap: spacing.sm,
  },
  paymentCard: {
    gap: spacing.sm,
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
