import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { getDocumentUrl } from '@/lib/data';
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
function amountStyle(entry: FinanceEntry) {
  // Investment is money in, same as a payment — it just isn't revenue.
  if (entry.type === 'payment' || entry.type === 'investment') {
    return { color: colors.mintDeep };
  }
  if (entry.type === 'expense') return { color: colors.coralDeep };
  return undefined;
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
      <View key={entry.id} style={index > 0 ? styles.rowBorderTop : undefined}>
        <Pressable
          onPress={() => openEntry(entry)}
          style={({ pressed }) => [
            styles.row,
            pressed && entry.document_path != null && styles.rowPressed,
          ]}>
          <View style={styles.iconWrap}>
            <Ionicons name={entryIcon(entry)} size={18} color={colors.ocean} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowValue} numberOfLines={1}>
              {entryTitle(entry)}
            </Text>
            <View style={styles.metaRow}>
              {entry.status ? (
                <View style={styles.statusChip}>
                  <Text style={styles.statusChipText}>{entry.status}</Text>
                </View>
              ) : null}
              {isStale(entry) ? (
                <View style={styles.staleChip}>
                  <Ionicons name="warning" size={11} color={colors.ink} />
                  <Text style={styles.staleChipText}>
                    {entry.document_path ? 'PDF out of date' : 'No PDF yet'}
                  </Text>
                </View>
              ) : null}
              <Text style={styles.metaText} numberOfLines={1}>
                {formatShortDate(entry.occurred_on)}
              </Text>
            </View>
          </View>
          {/* Amount and the action buttons share a right-hand column, stacked.
              They used to sit inline with the date, which let five-figure
              amounts collide with the recorded date on narrow phones. */}
          <View style={styles.rowRight}>
            <Text style={[styles.amountText, amountStyle(entry)]} numberOfLines={1}>
              {formatMoney(entry.amount)}
            </Text>
            <View style={styles.actionRow}>
              {entry.document_path ? (
                <Pressable
                  onPress={() => void shareEntry(entry)}
                  disabled={sharingId !== null}
                  hitSlop={6}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                  {sharingId === entry.id ? (
                    <ActivityIndicator size="small" color={colors.ocean} />
                  ) : (
                    <Ionicons name="share-outline" size={15} color={colors.ocean} />
                  )}
                </Pressable>
              ) : null}
              {entry.type === 'payment' ? (
                <Pressable
                  onPress={() => (splitId === entry.id ? setSplitId(null) : void startSplit(entry))}
                  hitSlop={6}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                  <Ionicons name="git-branch" size={15} color={colors.ocean} />
                </Pressable>
              ) : null}
              {revisable && (entry.revision ?? 1) > 1 ? (
                <Pressable
                  onPress={() => void toggleHistory(entry)}
                  hitSlop={6}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                  <Ionicons name="time-outline" size={15} color={colors.ocean} />
                </Pressable>
              ) : null}
              {entry.type === 'estimate' && entry.document_number ? (
                <Pressable
                  onPress={() => void duplicateAsInvoice(entry)}
                  disabled={duplicatingId !== null}
                  hitSlop={6}
                  style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                  {duplicatingId === entry.id ? (
                    <ActivityIndicator size="small" color={colors.ocean} />
                  ) : (
                    <Ionicons name="copy-outline" size={15} color={colors.ocean} />
                  )}
                </Pressable>
              ) : null}
              {/* Documents go to the builder, where the line items, the notes
                  and the PDF all move together. Payments, expenses,
                  investments and the document-less "Contract value" row have
                  nothing to re-render, so they keep the inline editor. */}
              <Pressable
                onPress={() =>
                  revisable ? openBuilder(entry) : editing ? cancelEdit() : startEdit(entry)
                }
                hitSlop={6}
                style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
                <Ionicons name="pencil" size={15} color={colors.ocean} />
              </Pressable>
              <Pressable
                onPress={() => void pressDelete(entry)}
                disabled={busyDelete}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.iconButton,
                  confirming && styles.iconButtonDanger,
                  pressed && styles.buttonPressed,
                ]}>
                {busyDelete ? (
                  <ActivityIndicator size="small" color={colors.danger} />
                ) : (
                  <Ionicons
                    name="trash"
                    size={15}
                    color={confirming ? colors.white : colors.inkSoft}
                  />
                )}
              </Pressable>
            </View>
          </View>
        </Pressable>
        {confirming ? (
          <Text style={styles.confirmHint}>Tap the trash again to delete this entry.</Text>
        ) : null}
        {historyId === entry.id ? (
          <View style={styles.editCard}>
            <Text style={styles.splitTitle}>Revision history</Text>
            {historyLoading ? (
              <ActivityIndicator color={colors.ocean} />
            ) : history.length === 0 ? (
              <Text style={styles.splitHint}>
                No archived revisions yet — this document was written before revisions were
                tracked.
              </Text>
            ) : (
              history.map((revision) => (
                <View key={revision.id} style={styles.historyRow}>
                  <Text style={styles.historyText} numberOfLines={1}>
                    rev {revision.revision} · {formatShortDate(revision.occurred_on)} ·{' '}
                    {formatMoney(revision.amount)}
                  </Text>
                  {revision.document_path ? (
                    <Pressable onPress={() => void openRevision(entry, revision)} hitSlop={8}>
                      <Text style={styles.historyLink}>view</Text>
                    </Pressable>
                  ) : (
                    <Text style={styles.historyMuted}>no PDF</Text>
                  )}
                </View>
              ))
            )}
          </View>
        ) : null}
        {splitId === entry.id ? (
          <View style={styles.editCard}>
            <Text style={styles.splitTitle}>
              Split {formatMoney(entry.amount)} across jobs
            </Text>
            <Text style={styles.splitHint}>
              For an ACH deposit covering several invoices. Amounts are yours to set — they
              don&apos;t have to match the invoiced figures.
            </Text>
            {splitRows.map((row, index) => (
              <View key={index} style={styles.splitRow}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <View style={styles.splitChips}>
                    {splitJobs.map((option) => (
                      <Pressable
                        key={option.id}
                        onPress={() =>
                          setSplitRows((rows) =>
                            rows.map((r, i) => (i === index ? { ...r, jobId: option.id } : r)),
                          )
                        }
                        style={[
                          styles.splitChip,
                          row.jobId === option.id && styles.splitChipActive,
                        ]}>
                        <Text
                          style={[
                            styles.splitChipText,
                            row.jobId === option.id && styles.splitChipTextActive,
                          ]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </ScrollView>
                <TextInput
                  style={styles.splitAmount}
                  value={row.amount}
                  onChangeText={(text) =>
                    setSplitRows((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, amount: text } : r)),
                    )
                  }
                  placeholder="0.00"
                  placeholderTextColor={colors.inkSoft}
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
                <Text style={[styles.splitTotals, left < 0 && styles.statusError]}>
                  {left < 0
                    ? `Over by ${formatMoney(Math.abs(left))}`
                    : `${formatMoney(allocated)} assigned · ${formatMoney(left)} left`}
                </Text>
              );
            })()}
            <View style={styles.editButtons}>
              <Pressable
                onPress={() => setSplitRows((rows) => [...rows, { jobId: null, amount: '' }])}
                hitSlop={8}>
                <Text style={styles.cancelText}>+ Add job</Text>
              </Pressable>
              <Pressable onPress={() => setSplitId(null)} disabled={savingSplit} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void saveSplit(entry)}
                disabled={savingSplit}
                style={({ pressed }) => [
                  styles.sunButton,
                  styles.saveEditButton,
                  (pressed || savingSplit) && styles.buttonPressed,
                ]}>
                {savingSplit ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <Text style={styles.sunButtonText}>Split</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}
        {editing ? (
          <View style={styles.editCard}>
            <Text style={styles.editLabel}>Amount ($)</Text>
            <TextInput
              style={styles.editInput}
              value={editAmount}
              onChangeText={setEditAmount}
              placeholder="0.00"
              placeholderTextColor={colors.inkSoft}
              keyboardType="decimal-pad"
            />
            <Text style={styles.editLabel}>Date (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.editInput}
              value={editDate}
              onChangeText={setEditDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.editLabel}>Description</Text>
            <TextInput
              style={styles.editInput}
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Description"
              placeholderTextColor={colors.inkSoft}
            />
            <View style={styles.editButtons}>
              <Pressable onPress={cancelEdit} disabled={savingEdit} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void saveEdit(entry)}
                disabled={savingEdit}
                style={({ pressed }) => [
                  styles.sunButton,
                  styles.saveEditButton,
                  (pressed || savingEdit) && styles.buttonPressed,
                ]}>
                {savingEdit ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <Text style={styles.sunButtonText}>Save</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <>
      <Text style={styles.sectionTitle}>Invoices, Estimates, &amp; Payments</Text>
      {state === 'loading' ? (
        <View style={styles.placeholderCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      ) : state === 'unavailable' ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="receipt" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>Invoices are not available right now.</Text>
        </View>
      ) : listRows.length === 0 ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="receipt" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>No invoices or estimates yet</Text>
        </View>
      ) : (
        <View style={styles.card}>{listRows.map(renderEntryRow)}</View>
      )}

      {state === 'ok' && expenses.length > 0 ? (
        <>
          <Pressable
            onPress={() => setExpensesOpen((open) => !open)}
            style={({ pressed }) => [styles.expensesToggle, pressed && styles.buttonPressed]}>
            <Ionicons
              name={expensesOpen ? 'chevron-down' : 'chevron-forward'}
              size={16}
              color={colors.inkSoft}
            />
            <Text style={styles.expensesToggleText}>
              {expensesOpen
                ? `Hide expenses (${expenses.length})`
                : `Show expenses (${expenses.length})`}
            </Text>
          </Pressable>
          {expensesOpen ? <View style={styles.card}>{expenses.map(renderEntryRow)}</View> : null}
        </>
      ) : null}

      <View style={styles.buttonRow}>
        <Pressable
          onPress={() => newDocument('estimate')}
          style={({ pressed }) => [styles.sunButton, pressed && styles.buttonPressed]}>
          <Ionicons name="calculator" size={16} color={colors.ink} />
          <Text style={styles.sunButtonText}>New estimate</Text>
        </Pressable>
        <Pressable
          onPress={() => newDocument('invoice')}
          style={({ pressed }) => [styles.sunButton, pressed && styles.buttonPressed]}>
          <Ionicons name="receipt" size={16} color={colors.ink} />
          <Text style={styles.sunButtonText}>New invoice</Text>
        </Pressable>
      </View>

      {paymentInputOpen ? (
        <View style={styles.paymentCard}>
          <Text style={styles.paymentLabel}>Payment amount ($)</Text>
          <View style={styles.paymentRow}>
            <TextInput
              style={styles.paymentInput}
              value={paymentAmount}
              onChangeText={setPaymentAmount}
              placeholder="0.00"
              placeholderTextColor={colors.inkSoft}
              keyboardType="decimal-pad"
            />
            <Pressable
              onPress={() => savePayment(paymentAmount)}
              disabled={savingPayment}
              style={({ pressed }) => [
                styles.sunButton,
                (pressed || savingPayment) && styles.buttonPressed,
              ]}>
              {savingPayment ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Text style={styles.sunButtonText}>Record</Text>
              )}
            </Pressable>
            <Pressable onPress={() => setPaymentInputOpen(false)} hitSlop={8}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={promptPayment}
          disabled={savingPayment}
          style={({ pressed }) => [
            styles.outlineButton,
            (pressed || savingPayment) && styles.buttonPressed,
          ]}>
          {savingPayment ? (
            <ActivityIndicator color={colors.ink} />
          ) : (
            <Ionicons name="cash" size={16} color={colors.ink} />
          )}
          <Text style={styles.outlineButtonText}>Record payment</Text>
        </Pressable>
      )}

      {status ? (
        <Text
          style={[
            styles.statusText,
            status.kind === 'error' ? styles.statusError : styles.statusSuccess,
          ]}>
          {status.message}
        </Text>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  placeholderCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  placeholderText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  rowRight: {
    alignItems: 'flex-end',
    flexShrink: 0,
    gap: spacing.xs + 2,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  statusChip: {
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  statusChipText: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'capitalize',
  },
  metaText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  staleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  staleChipText: {
    color: colors.ink,
    fontSize: 11,
    fontWeight: '800',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  historyText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    flexShrink: 1,
  },
  historyLink: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  historyMuted: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  amountText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  iconButton: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  confirmHint: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    textAlign: 'right',
  },
  splitTitle: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  splitHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
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
  splitChip: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  splitChipActive: {
    backgroundColor: colors.ocean,
    borderColor: colors.ocean,
  },
  splitChipText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
  },
  splitChipTextActive: {
    color: colors.white,
  },
  splitAmount: {
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  splitTotals: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
    textAlign: 'right',
  },
  editCard: {
    backgroundColor: colors.cream,
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.xs,
  },
  editLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  editInput: {
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  saveEditButton: {
    flexGrow: 0,
    paddingHorizontal: spacing.lg,
  },
  expensesToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  expensesToggleText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
  },
  buttonRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  sunButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    flexGrow: 1,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
    ...shadows.card,
  },
  sunButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  buttonPressed: {
    opacity: 0.7,
  },
  outlineButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
  },
  outlineButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  paymentCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  paymentLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  paymentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  paymentInput: {
    flex: 1,
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  cancelText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusError: {
    color: colors.danger,
  },
  statusSuccess: {
    color: colors.ocean,
  },
});
