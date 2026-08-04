import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
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
  fetchJobFinanceEntries,
  recordPayment,
  updateFinanceEntry,
  type FinanceEntry,
} from '@/lib/documents';
import { type Job } from '@/lib/mockData';
import { isValidISODate } from '@/lib/time';

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function entryIcon(entry: FinanceEntry): keyof typeof Ionicons.glyphMap {
  if (entry.type === 'invoice') return 'receipt';
  if (entry.type === 'estimate') return 'calculator';
  if (entry.type === 'payment') return 'cash';
  return 'pricetag';
}

/** Money in is green, money out is coral, paperwork stays ink. */
function amountStyle(entry: FinanceEntry) {
  if (entry.type === 'payment') return { color: colors.mintDeep };
  if (entry.type === 'expense') return { color: colors.coralDeep };
  return undefined;
}

function entryTitle(entry: FinanceEntry): string {
  if (entry.type === 'invoice') return entry.document_number ?? 'Invoice';
  if (entry.type === 'estimate') return entry.document_number ?? 'Estimate';
  if (entry.type === 'payment') return 'Payment';
  return entry.description ?? 'Expense';
}

/**
 * Admin-only "Invoices & estimates" card for a job: lists finance entries
 * of type invoice/estimate/payment (plus a collapsible expenses subsection),
 * with buttons to create new documents and to record a payment. Rows can be
 * edited inline (amount / date / description) and deleted with a two-tap
 * confirm — both admin-only via RLS (needs the finance-entries migration).
 * The parent must gate rendering on isAdmin + non-demo job; pass
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

  const listRows = entries.filter(
    (e) => e.type === 'invoice' || e.type === 'estimate' || e.type === 'payment',
  );
  const expenses = entries.filter((e) => e.type === 'expense');
  const invoiced = entries
    .filter((e) => e.type === 'invoice')
    .reduce((sum, e) => sum + e.amount, 0);
  const paid = entries.filter((e) => e.type === 'payment').reduce((sum, e) => sum + e.amount, 0);
  const defaultPayment = Math.max(0, invoiced - paid);

  const openEntry = async (entry: FinanceEntry) => {
    if (!entry.document_path) return;
    const url = await getDocumentUrl(entry.document_path);
    if (!url || !(await viewDocument(url))) {
      setStatus({ kind: 'error', message: 'Could not open the document. Please try again.' });
    }
  };

  const shareEntry = async (entry: FinanceEntry) => {
    if (!entry.document_path) return;
    setSharingId(entry.id);
    try {
      const url = await getDocumentUrl(entry.document_path);
      const fileName = `${entry.document_number ?? 'document'}.pdf`;
      if (!url || !(await shareDocument(url, fileName))) {
        setStatus({ kind: 'error', message: 'Could not share the document. Please try again.' });
      }
    } finally {
      setSharingId(null);
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
              <Pressable
                onPress={() => (editing ? cancelEdit() : startEdit(entry))}
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
