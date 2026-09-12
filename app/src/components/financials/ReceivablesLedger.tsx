import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { Field } from '@/components/forms/Field';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  SectionHeader,
  StatTile,
} from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { formatShortDate, todayISO } from '@/lib/dates';
import { deleteFinanceEntry, updateFinanceEntry } from '@/lib/documents';
import {
  groupExpensesByMonth,
  recordDeposit,
  type LedgerEntry,
  type OutstandingReceivables,
} from '@/lib/financials';
import * as haptics from '@/lib/haptics';
import { isValidISODate } from '@/lib/time';
import type { Job } from '@/lib/types';

import { JobPicker, MonthHeader, type JobOption } from './ExpenseLedger';
import { formatMoney } from './format';

/** Money in is green everywhere on this tab; this is that green. */
const MONEY_IN = hubColors.hr.fg;

/** A deposit the email scanner logged straight from a Chase alert. */
function isBankDeposit(entry: LedgerEntry): boolean {
  return entry.extracted?.source === 'email-scanner';
}

/**
 * Receivables — every deposit the company has taken in, shown the way the
 * expense ledger above it shows money out: grouped by month with subtotals,
 * one row per `payment` entry, inline edit and two-tap delete, and the same
 * job picker so a scanner-filed deposit can be moved onto the project it
 * paid for.
 *
 * Built as the expense ledger's twin on purpose (owner's ask, 2026-09-12):
 * the two sections share `MonthHeader`, `JobPicker` and the row anatomy, so
 * reading one teaches you the other. Rows are drawn straight rather than
 * through the SectionList — a company this size has tens of deposits, not
 * thousands, and keeping the section self-contained keeps the screen simple.
 *
 * Splitting one deposit across several jobs lives on the job's own Invoices
 * card (`JobInvoices`), where the allocation editor already exists. A row with
 * a job links there instead of growing a second copy of that editor.
 */
export function ReceivablesLedger({
  entries,
  paidYtd,
  paidThisMonth,
  outstanding,
  jobs,
  jobOptions,
  companyJobId,
  jobLabels,
  onChanged,
}: {
  /** Every `payment` row, newest first. */
  entries: LedgerEntry[];
  paidYtd: number;
  paidThisMonth: number;
  /** Null when the pipeline totals could not be loaded — the tile hides. */
  outstanding: OutstandingReceivables | null;
  /** Full job rows, for the customer behind a job when recording a deposit. */
  jobs: Job[];
  jobOptions: JobOption[];
  companyJobId: string | null;
  jobLabels: Map<string, string>;
  /** Refetch after any write; the parent owns the data. */
  onChanged: () => Promise<void>;
}) {
  const router = useRouter();

  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [monthsInitialized, setMonthsInitialized] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  // Add-deposit form.
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [receivedFrom, setReceivedFrom] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [jobId, setJobId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inline row editing + two-tap delete, same as the expense ledger.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editJobId, setEditJobId] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const months = useMemo(() => groupExpensesByMonth(entries), [entries]);

  // Open the newest month by default, once, on first load.
  useEffect(() => {
    if (monthsInitialized || months.length === 0) return;
    setOpenMonths(new Set([months[0].key]));
    setMonthsInitialized(true);
  }, [months, monthsInitialized]);

  const toggleMonth = (key: string) => {
    setOpenMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const resetForm = () => {
    setAmount('');
    setReceivedFrom('');
    setDescription('');
    setDate(todayISO());
    setJobId(null);
  };

  const saveDeposit = async () => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const day = date.trim();
    if (!isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-09-12).' });
      return;
    }
    if (!jobId) {
      setStatus({ kind: 'error', message: 'Pick the job this deposit paid for.' });
      return;
    }
    setSaving(true);
    setStatus(null);
    const job = jobs.find((j) => j.id === jobId) ?? null;
    const from = receivedFrom.trim();
    const desc = description.trim();
    const result = await recordDeposit({
      amount: value,
      counterparty: from === '' ? (job?.customer?.name ?? null) : from,
      description: desc === '' ? null : desc,
      occurredOn: day,
      jobId,
      customerId: job?.customer_id ?? null,
    });
    setSaving(false);
    if (result.ok) {
      haptics.success();
      setFormOpen(false);
      resetForm();
      setStatus({ kind: 'success', message: `Deposit of ${formatMoney(value)} recorded.` });
      await onChanged();
    } else {
      setStatus({ kind: 'error', message: `Could not save the deposit: ${result.message}` });
    }
  };

  const startEdit = (entry: LedgerEntry) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(entry.id);
    setEditAmount(entry.amount > 0 ? String(entry.amount) : '');
    setEditDate(entry.occurred_on ?? '');
    setEditDescription(entry.description ?? '');
    setEditJobId(entry.job_id);
  };

  const saveEdit = async (entry: LedgerEntry) => {
    const value = Number(editAmount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const day = editDate.trim();
    if (day !== '' && !isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-09-12).' });
      return;
    }
    setSavingEdit(true);
    setStatus(null);
    const desc = editDescription.trim();
    const result = await updateFinanceEntry(entry.id, {
      amount: value,
      occurred_on: day === '' ? null : day,
      description: desc === '' ? null : desc,
      job_id: editJobId,
    });
    setSavingEdit(false);
    if (result.ok) {
      haptics.success();
      setEditingId(null);
      setStatus({ kind: 'success', message: 'Deposit updated.' });
      await onChanged();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const pressDelete = async (entry: LedgerEntry) => {
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
      setStatus({ kind: 'success', message: 'Deposit deleted.' });
      await onChanged();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const openJob = (id: string) => router.push(`/job/${id}` as never);

  return (
    <View style={styles.section}>
      <View style={styles.headerRow}>
        <SectionHeader
          title="Receivables"
          icon="cash"
          accent={hubColors.systems.fg}
          style={styles.headerTitle}
        />
        <Button
          label={formOpen ? 'Close' : '+ Add deposit'}
          size="sm"
          variant={formOpen ? 'secondary' : 'primary'}
          onPress={() => {
            setStatus(null);
            setFormOpen((open) => !open);
          }}
        />
      </View>

      <ReceivablesTiles paidYtd={paidYtd} paidThisMonth={paidThisMonth} outstanding={outstanding} />

      {formOpen ? (
        <Card style={styles.formCard}>
          <Field
            label="Amount ($)"
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            keyboardType="decimal-pad"
          />
          <Field
            label="Received from (optional)"
            value={receivedFrom}
            onChangeText={setReceivedFrom}
            placeholder="Defaults to the job's customer"
          />
          <Field
            label="Description (optional)"
            value={description}
            onChangeText={setDescription}
            placeholder="Payment received"
          />
          <Field
            label="Date (YYYY-MM-DD)"
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {jobOptions.length > 0 || companyJobId ? (
            <JobPicker
              label="Job"
              options={jobOptions}
              companyJobId={companyJobId}
              selected={jobId}
              onSelect={setJobId}
            />
          ) : null}
          {jobId !== null && jobId === companyJobId ? (
            <AppText variant="caption" color={colors.coralDeep} style={styles.formWarning}>
              ⚠ Company earns no revenue. File a deposit here only until you know which job it
              paid for.
            </AppText>
          ) : null}
          <Button
            label="Record deposit"
            icon="cash"
            onPress={() => void saveDeposit()}
            loading={saving}
            disabled={saving}
            fullWidth
            style={styles.saveButton}
          />
        </Card>
      ) : null}

      {status ? (
        <AppText
          variant="caption"
          align="center"
          color={status.kind === 'error' ? colors.danger : colors.accentPrimary}
          style={styles.status}>
          {status.message}
        </AppText>
      ) : null}

      {months.length === 0 ? (
        <Card>
          <EmptyState
            icon="cash-outline"
            title="No deposits recorded yet"
            body="Bank deposits the email scanner logs and payments recorded on a job both land here."
          />
        </Card>
      ) : (
        months.map((month) => {
          const open = openMonths.has(month.key);
          return (
            <View key={month.key}>
              <MonthHeader
                label={month.label}
                count={month.entries.length}
                total={month.total}
                open={open}
                onToggle={() => toggleMonth(month.key)}
                noun="deposit"
              />
              {open
                ? month.entries.map((entry, index) => (
                    <DepositRow
                      key={entry.id}
                      entry={entry}
                      index={index}
                      isFirst={index === 0}
                      isLast={index === month.entries.length - 1}
                      jobLabel={entry.job_id ? (jobLabels.get(entry.job_id) ?? null) : null}
                      misfiled={entry.job_id === null || entry.job_id === companyJobId}
                      onOpenJob={entry.job_id ? () => openJob(entry.job_id as string) : null}
                      editing={editingId === entry.id}
                      confirming={confirmDeleteId === entry.id}
                      busyDelete={deletingId === entry.id}
                      savingEdit={savingEdit}
                      editAmount={editAmount}
                      onEditAmount={setEditAmount}
                      editDate={editDate}
                      onEditDate={setEditDate}
                      editDescription={editDescription}
                      onEditDescription={setEditDescription}
                      editJobId={editJobId}
                      onEditJobId={setEditJobId}
                      jobOptions={jobOptions}
                      companyJobId={companyJobId}
                      onToggleEdit={() =>
                        editingId === entry.id ? setEditingId(null) : startEdit(entry)
                      }
                      onCancelEdit={() => setEditingId(null)}
                      onSaveEdit={() => void saveEdit(entry)}
                      onDelete={() => void pressDelete(entry)}
                    />
                  ))
                : null}
            </View>
          );
        })
      )}
    </View>
  );
}

/**
 * The three receivables headline figures. Received is the same payment rows
 * the ledger lists (summed in lib/financials); Outstanding is the Pipeline
 * mirror's "Actively Invoiced" jobs with what they have already paid taken
 * off — see `outstandingReceivables`.
 */
function ReceivablesTiles({
  paidYtd,
  paidThisMonth,
  outstanding,
}: {
  paidYtd: number;
  paidThisMonth: number;
  outstanding: OutstandingReceivables | null;
}) {
  const tiles: { label: string; value: number; tone: number; note?: string }[] = [
    { label: 'Received YTD', value: paidYtd, tone: 6 },
    { label: 'Received this month', value: paidThisMonth, tone: 6 },
  ];
  if (outstanding) {
    tiles.push({
      label: 'Outstanding',
      value: outstanding.total,
      tone: 5,
      note:
        outstanding.jobs === 0
          ? 'nothing invoiced is unpaid'
          : `${outstanding.jobs} invoiced ${outstanding.jobs === 1 ? 'job' : 'jobs'} still owe`,
    });
  }
  // Build 33: three tiles used to share one row at a third each, which on a
  // phone broke "Outstanding" mid-word and floated its note over the amount.
  // The two "received" tiles keep a row of halves; the tile that carries a
  // note (Outstanding) takes the full width below them, with its note laid
  // out inside the tile. Every value stays the live figure.
  return (
    <View style={styles.grid}>
      {tiles.map((tile, index) => (
        <FadeInUp
          key={tile.label}
          index={index}
          style={[styles.cell, tile.note ? styles.cellFull : null]}>
          <View style={styles.tileWrap}>
            <StatTile
              label={tile.label}
              value={tile.value}
              prefix="$"
              tone={tile.tone}
              note={tile.note}
              countUp
              edge
              style={styles.tile}
            />
          </View>
        </FadeInUp>
      ))}
    </View>
  );
}

/**
 * One deposit in the ledger, with its inline editor — the `ExpenseRow`
 * anatomy with the expense-only parts swapped: the amount is green, the
 * "paid from" toggle is gone (a deposit is always bank-side), a "Bank" mark
 * says the scanner saw this land, and a deposit parked on the Company
 * container carries the same ⚠ line the P&L sheet shows.
 */
function DepositRow({
  entry,
  index,
  isFirst,
  isLast,
  jobLabel,
  misfiled,
  onOpenJob,
  editing,
  confirming,
  busyDelete,
  savingEdit,
  editAmount,
  onEditAmount,
  editDate,
  onEditDate,
  editDescription,
  onEditDescription,
  editJobId,
  onEditJobId,
  jobOptions,
  companyJobId,
  onToggleEdit,
  onCancelEdit,
  onSaveEdit,
  onDelete,
}: {
  entry: LedgerEntry;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  jobLabel: string | null;
  /** Parked on the Company container or on no job at all — either is a to-do. */
  misfiled: boolean;
  onOpenJob: (() => void) | null;
  editing: boolean;
  confirming: boolean;
  busyDelete: boolean;
  savingEdit: boolean;
  editAmount: string;
  onEditAmount: (text: string) => void;
  editDate: string;
  onEditDate: (text: string) => void;
  editDescription: string;
  onEditDescription: (text: string) => void;
  editJobId: string | null;
  onEditJobId: (id: string | null) => void;
  jobOptions: JobOption[];
  companyJobId: string | null;
  onToggleEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onDelete: () => void;
}) {
  const bank = isBankDeposit(entry);
  const title = entry.counterparty ?? entry.description ?? 'Deposit';
  // The description is the second line unless it IS the title already.
  const detail = entry.counterparty && entry.description ? entry.description : null;

  return (
    <FadeInUp index={index}>
      <View
        style={[
          styles.rowCard,
          !isFirst && styles.rowBorderTop,
          isFirst && styles.rowFirst,
          isLast && styles.rowLast,
        ]}>
        <View style={styles.row}>
          <View style={styles.iconWrap}>
            <Ionicons name="arrow-down-circle" size={18} color={MONEY_IN} />
          </View>

          <View style={styles.rowBody}>
            <AppText variant="bodyStrong" numberOfLines={1}>
              {title}
            </AppText>
            <View style={styles.metaRow}>
              {jobLabel ? (
                <Chip
                  label={jobLabel}
                  tone={misfiled ? 'olive' : 'ocean'}
                  onPress={onOpenJob ?? undefined}
                />
              ) : null}
              {bank ? <Chip label="Bank" icon="business" tone="success" /> : null}
              <AppText
                variant="caption"
                color={colors.textMuted}
                numberOfLines={1}
                style={styles.metaText}>
                {formatShortDate(entry.occurred_on)}
                {detail ? ` · ${detail}` : ''}
              </AppText>
            </View>
          </View>

          <AppText variant="bodyStrong" color={MONEY_IN} style={styles.figure}>
            {formatMoney(entry.amount)}
          </AppText>

          <AnimatedPressable
            onPress={onToggleEdit}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Close editor' : 'Edit deposit'}
            style={styles.iconButton}>
            <Ionicons name="pencil" size={15} color={colors.accentPrimary} />
          </AnimatedPressable>

          <AnimatedPressable
            onPress={onDelete}
            disabled={busyDelete}
            haptic={confirming ? 'warn' : 'tapLight'}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={confirming ? 'Confirm delete' : 'Delete deposit'}
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

        {misfiled ? (
          <AppText variant="caption" color={colors.coralDeep} style={styles.misfiled}>
            {entry.job_id === null
              ? '⚠ Not assigned to a job — edit this deposit and pick the job it paid for.'
              : '⚠ Filed under Company. Company earns no revenue — edit this deposit and assign it to the job it paid for.'}
          </AppText>
        ) : null}

        {confirming ? (
          <AppText variant="caption" color={colors.danger} style={styles.confirmHint}>
            Tap the trash again to delete this deposit.
          </AppText>
        ) : null}

        {editing ? (
          <Card tone="sunk" style={styles.editCard}>
            <Field
              label="Amount ($)"
              value={editAmount}
              onChangeText={onEditAmount}
              placeholder="0.00"
              keyboardType="decimal-pad"
            />
            <Field
              label="Date (YYYY-MM-DD)"
              value={editDate}
              onChangeText={onEditDate}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Field
              label="Description"
              value={editDescription}
              onChangeText={onEditDescription}
              placeholder="Description"
            />
            {jobOptions.length > 0 || companyJobId ? (
              <JobPicker
                label="Job"
                options={jobOptions}
                companyJobId={companyJobId}
                selected={editJobId}
                onSelect={onEditJobId}
              />
            ) : null}
            {onOpenJob && !misfiled ? (
              <AnimatedPressable
                onPress={onOpenJob}
                haptic="tapLight"
                accessibilityRole="button"
                accessibilityLabel="Split this deposit across jobs on the job screen"
                style={styles.splitLink}>
                <Ionicons name="git-branch" size={14} color={colors.accentPrimary} />
                <AppText variant="caption" color={colors.accentPrimary}>
                  One deposit for several jobs? Split it from the job&apos;s Invoices card.
                </AppText>
              </AnimatedPressable>
            ) : null}
            <View style={styles.editButtons}>
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={savingEdit}
                onPress={onCancelEdit}
              />
              <Button
                label="Save"
                size="sm"
                loading={savingEdit}
                disabled={savingEdit}
                onPress={onSaveEdit}
              />
            </View>
          </Card>
        ) : null}
      </View>
    </FadeInUp>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.lg,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  headerTitle: {
    flex: 1,
    marginBottom: 0,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginHorizontal: -spacing.xs,
    marginBottom: spacing.xs,
  },
  cell: {
    width: '50%',
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  cellFull: {
    width: '100%',
  },
  tileWrap: {
    alignSelf: 'stretch',
  },
  tile: {
    minWidth: 0,
  },
  formCard: {
    marginBottom: spacing.md,
  },
  formWarning: {
    marginBottom: spacing.sm,
  },
  saveButton: {
    marginTop: spacing.xs,
  },
  status: {
    marginBottom: spacing.sm,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
  rowCard: {
    backgroundColor: colors.surface,
  },
  rowFirst: {
    borderTopLeftRadius: radii.md,
    borderTopRightRadius: radii.md,
  },
  rowLast: {
    borderBottomLeftRadius: radii.md,
    borderBottomRightRadius: radii.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: hubColors.hr.bg,
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
    gap: spacing.sm,
  },
  metaText: {
    flexShrink: 1,
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
  misfiled: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  confirmHint: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    textAlign: 'right',
  },
  editCard: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
  },
  splitLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
});
