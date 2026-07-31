import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate, todayISO } from '@/lib/dates';
import { deleteFinanceEntry, updateFinanceEntry } from '@/lib/documents';
import {
  fetchFinancials,
  groupExpensesByMonth,
  recordExpense,
  type FinancialsData,
  type LedgerEntry,
} from '@/lib/financials';
import { type Job } from '@/lib/mockData';
import {
  fetchCompanyTotals,
  fetchLaborHoursByJob,
  fetchPipelineJobs,
  type CompanyTotals,
  type JobLaborHours,
} from '@/lib/pipeline';
import { useRole } from '@/lib/role';
import { isValidISODate } from '@/lib/time';

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatRounded(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** Compact picker option for tying an expense to a job. */
interface JobOption {
  id: string;
  label: string;
}

function OverviewCard({ data }: { data: FinancialsData }) {
  const tiles: [string, string, object?][] = [
    ['Paid in', formatRounded(data.paid)],
    ['Expenses', formatRounded(data.expenses)],
    [
      'Net',
      `${data.net >= 0 ? '+' : '−'}${formatRounded(Math.abs(data.net))}`,
      data.net >= 0 ? styles.netPositive : styles.netNegative,
    ],
    ['This month', formatRounded(data.expensesThisMonth)],
  ];
  return (
    <View style={styles.overviewCard}>
      <View style={styles.overviewGrid}>
        {tiles.map(([label, value, valueStyle]) => (
          <View key={label} style={styles.overviewTile}>
            <Text style={styles.tileLabel}>{label}</Text>
            <Text
              style={[styles.tileValue, valueStyle]}
              numberOfLines={1}
              adjustsFontSizeToFit>
              {value}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}

/**
 * Pipeline-mirror card: the exact numbers from the Pipeline header, each
 * money tile tappable to its company-wide drill-down ledger.
 */
function PipelineTotalsCard({ totals }: { totals: CompanyTotals }) {
  const router = useRouter();
  const pnl = totals.avgProfitPct;
  const tiles: { label: string; amount: number; view: string }[] = [
    { label: 'Estimates', amount: totals.estimates, view: 'estimates' },
    { label: 'Contracted', amount: totals.contracted, view: 'contracted' },
    { label: 'Invoiced', amount: totals.invoiced, view: 'invoices' },
    { label: 'Paid', amount: totals.paid, view: 'paid' },
  ];
  return (
    <View style={styles.overviewCard}>
      <View style={styles.overviewGrid}>
        {tiles.map((tile) => (
          <Pressable
            key={tile.label}
            onPress={() => router.push(`/ledger/${tile.view}` as never)}
            style={({ pressed }) => [styles.overviewTile, pressed && styles.buttonPressed]}>
            <View style={styles.tileLabelRow}>
              <Text style={styles.tileLabel}>{tile.label}</Text>
              <Ionicons name="chevron-forward" size={12} color={colors.ocean} />
            </View>
            <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
              {formatRounded(tile.amount)}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.profitRow}>
        <View>
          <Text style={styles.tileLabel}>Avg Profit</Text>
          <Text style={styles.profitSublabel}>completed jobs</Text>
        </View>
        <Text
          style={[
            styles.profitValue,
            pnl !== null && (pnl >= 0 ? styles.netPositive : styles.netNegative),
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit>
          {pnl !== null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}%` : '—'}
        </Text>
      </View>
    </View>
  );
}

export default function FinancialsScreen() {
  const role = useRole();
  const router = useRouter();

  const [data, setData] = useState<FinancialsData | null>(null);
  const [totals, setTotals] = useState<CompanyTotals | null>(null);
  const [jobsFull, setJobsFull] = useState<Job[]>([]);
  const [laborMap, setLaborMap] = useState<Map<string, JobLaborHours> | null>(null);
  // Collapsible sections: the per-job P&L sheet and each expense month.
  const [pnlOpen, setPnlOpen] = useState(false);
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());
  const [monthsInitialized, setMonthsInitialized] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [jobOptions, setJobOptions] = useState<JobOption[]>([]);
  const [jobLabels, setJobLabels] = useState<Map<string, string>>(new Map());
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  // Add-expense form.
  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [date, setDate] = useState(todayISO());
  const [jobId, setJobId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Inline row editing + two-tap delete (same behavior as JobInvoices).
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (role?.isAdmin) {
      const [financials, { jobs, isMock }, labor] = await Promise.all([
        fetchFinancials(),
        fetchPipelineJobs(),
        fetchLaborHoursByJob(),
      ]);
      setData(financials);
      setLaborMap(labor);
      // Same math as the Pipeline header, fed by the same rows we just got.
      setTotals(
        financials && !isMock ? await fetchCompanyTotals(jobs, financials.allEntries) : null,
      );
      if (!isMock) {
        setJobsFull(jobs);
        setJobOptions(jobs.map((j) => ({ id: j.id, label: j.job_number ?? j.name })));
        setJobLabels(new Map(jobs.map((j) => [j.id, j.job_number ?? j.name])));
      }
    } else {
      setData(null);
      setTotals(null);
      setJobsFull([]);
      setLaborMap(null);
    }
    setLoaded(true);
  }, [role]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // Expense months are collapsible: a closed month contributes no rows.
  const monthGroups = useMemo(
    () => (data ? groupExpensesByMonth(data.expenseEntries) : []),
    [data],
  );

  // Open the newest month by default, once, on first load.
  useEffect(() => {
    if (monthsInitialized || monthGroups.length === 0) return;
    setOpenMonths(new Set([monthGroups[0].key]));
    setMonthsInitialized(true);
  }, [monthGroups, monthsInitialized]);

  const sections = useMemo(
    () =>
      monthGroups.map((month) => ({
        ...month,
        data: openMonths.has(month.key) ? month.entries : [],
      })),
    [monthGroups, openMonths],
  );

  const toggleMonth = (key: string) => {
    setOpenMonths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Per-job P&L rows: revenue = payments received; profit % of revenue.
  const pnlRows = useMemo(() => {
    if (!data) return [];
    const paidByJob = new Map<string, number>();
    const expByJob = new Map<string, number>();
    for (const entry of data.allEntries) {
      if (!entry.job_id) continue;
      if (entry.type === 'payment') {
        paidByJob.set(entry.job_id, (paidByJob.get(entry.job_id) ?? 0) + entry.amount);
      } else if (entry.type === 'expense') {
        expByJob.set(entry.job_id, (expByJob.get(entry.job_id) ?? 0) + entry.amount);
      }
    }
    return jobsFull.map((job) => {
      const revenue = paidByJob.get(job.id) ?? 0;
      const expensesJob = expByJob.get(job.id) ?? 0;
      const labor = laborMap?.get(job.id)?.labor ?? 0;
      const hours = laborMap?.get(job.id)?.hours ?? 0;
      const pct = revenue > 0 ? ((revenue - expensesJob - labor) / revenue) * 100 : null;
      return {
        id: job.id,
        label: job.job_number ?? job.name,
        name: job.name,
        revenue,
        expenses: expensesJob,
        hours,
        labor,
        pct,
      };
    });
  }, [data, jobsFull, laborMap]);

  const resetForm = () => {
    setAmount('');
    setDescription('');
    setPaidTo('');
    setDate(todayISO());
    setJobId(null);
  };

  const saveExpense = async () => {
    const value = Number(amount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const desc = description.trim();
    if (desc === '') {
      setStatus({ kind: 'error', message: 'Enter a short description of the expense.' });
      return;
    }
    const day = date.trim();
    if (!isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-07-27).' });
      return;
    }
    setSaving(true);
    setStatus(null);
    const counterparty = paidTo.trim();
    const result = await recordExpense({
      amount: value,
      description: desc,
      counterparty: counterparty === '' ? null : counterparty,
      occurredOn: day,
      jobId,
    });
    setSaving(false);
    if (result.ok) {
      setFormOpen(false);
      resetForm();
      setStatus({ kind: 'success', message: `Expense of ${formatMoney(value)} recorded.` });
      await load();
    } else {
      setStatus({ kind: 'error', message: `Could not save the expense: ${result.message}` });
    }
  };

  const startEdit = (entry: LedgerEntry) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(entry.id);
    setEditAmount(entry.amount > 0 ? String(entry.amount) : '');
    setEditDate(entry.occurred_on ?? '');
    setEditDescription(entry.description ?? '');
  };

  const saveEdit = async (entry: LedgerEntry) => {
    const value = Number(editAmount.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(value) || value <= 0) {
      setStatus({ kind: 'error', message: 'Enter an amount greater than zero.' });
      return;
    }
    const day = editDate.trim();
    if (day !== '' && !isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-07-27).' });
      return;
    }
    setSavingEdit(true);
    setStatus(null);
    const desc = editDescription.trim();
    const result = await updateFinanceEntry(entry.id, {
      amount: value,
      occurred_on: day === '' ? null : day,
      description: desc === '' ? null : desc,
    });
    setSavingEdit(false);
    if (result.ok) {
      setEditingId(null);
      setStatus({ kind: 'success', message: 'Expense updated.' });
      await load();
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
      setStatus({ kind: 'success', message: 'Expense deleted.' });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const renderRow = ({
    item,
    index,
    section,
  }: {
    item: LedgerEntry;
    index: number;
    section: { data: LedgerEntry[] };
  }) => {
    const confirming = confirmDeleteId === item.id;
    const busyDelete = deletingId === item.id;
    const editing = editingId === item.id;
    const jobLabel = item.job_id ? jobLabels.get(item.job_id) : null;
    return (
      <View
        style={[
          styles.rowCard,
          index > 0 && styles.rowBorderTop,
          index === 0 && styles.rowFirst,
          index === section.data.length - 1 && styles.rowLast,
        ]}>
        <View style={styles.row}>
          <View style={styles.iconWrap}>
            <Ionicons name="pricetag" size={18} color={colors.ocean} />
          </View>
          <View style={styles.rowBody}>
            <Text style={styles.rowValue} numberOfLines={1}>
              {item.description ?? item.counterparty ?? 'Expense'}
            </Text>
            <View style={styles.metaRow}>
              {jobLabel ? (
                <View style={styles.jobChip}>
                  <Text style={styles.jobChipText}>{jobLabel}</Text>
                </View>
              ) : null}
              <Text style={styles.metaText}>
                {formatShortDate(item.occurred_on)}
                {item.counterparty && item.description ? ` · ${item.counterparty}` : ''}
              </Text>
            </View>
          </View>
          <Text style={styles.amountText}>{formatMoney(item.amount)}</Text>
          <Pressable
            onPress={() => (editing ? setEditingId(null) : startEdit(item))}
            hitSlop={6}
            style={({ pressed }) => [styles.iconButton, pressed && styles.buttonPressed]}>
            <Ionicons name="pencil" size={15} color={colors.ocean} />
          </Pressable>
          <Pressable
            onPress={() => void pressDelete(item)}
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
        {confirming ? (
          <Text style={styles.confirmHint}>Tap the trash again to delete this expense.</Text>
        ) : null}
        {editing ? (
          <View style={styles.editCard}>
            <Text style={styles.fieldLabel}>Amount ($)</Text>
            <TextInput
              style={styles.input}
              value={editAmount}
              onChangeText={setEditAmount}
              placeholder="0.00"
              placeholderTextColor={colors.inkSoft}
              keyboardType="decimal-pad"
            />
            <Text style={styles.fieldLabel}>Date (YYYY-MM-DD)</Text>
            <TextInput
              style={styles.input}
              value={editDate}
              onChangeText={setEditDate}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={styles.fieldLabel}>Description</Text>
            <TextInput
              style={styles.input}
              value={editDescription}
              onChangeText={setEditDescription}
              placeholder="Description"
              placeholderTextColor={colors.inkSoft}
            />
            <View style={styles.editButtons}>
              <Pressable onPress={() => setEditingId(null)} disabled={savingEdit} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void saveEdit(item)}
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

  const placeholder = (message: string) => (
    <View style={styles.placeholderCard}>
      <Ionicons name="wallet" size={22} color={colors.inkSoft} />
      <Text style={styles.placeholderText}>{message}</Text>
    </View>
  );

  const header = (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Financials</Text>
      </View>

      {!loaded ? null : !role ? (
        placeholder('Sign in to see company financials.')
      ) : !role.isAdmin ? (
        placeholder('Financials are available to owners and operators.')
      ) : !data ? (
        placeholder('Financials are not available right now.')
      ) : (
        <>
          <OverviewCard data={data} />
          {totals ? <PipelineTotalsCard totals={totals} /> : null}

          {pnlRows.length > 0 ? (
            <>
              <Pressable
                onPress={() => setPnlOpen((open) => !open)}
                style={({ pressed }) => [styles.sectionToggle, pressed && styles.buttonPressed]}>
                <Ionicons
                  name={pnlOpen ? 'chevron-down' : 'chevron-forward'}
                  size={18}
                  color={colors.ocean}
                />
                <Text style={styles.sectionTitleInline}>Per-job P&amp;L</Text>
                <Text style={styles.sectionToggleHint}>
                  {pnlOpen ? 'Hide' : `${pnlRows.length} jobs`}
                </Text>
              </Pressable>
              {pnlOpen ? (
                <View style={styles.pnlCard}>
                  {pnlRows.map((row, index) => (
                    <Pressable
                      key={row.id}
                      onPress={() =>
                        router.push({ pathname: '/job/[id]', params: { id: row.id } })
                      }
                      style={({ pressed }) => [
                        styles.pnlRow,
                        index > 0 && styles.pnlRowBorder,
                        pressed && styles.buttonPressed,
                      ]}>
                      <View style={styles.pnlTopRow}>
                        <View style={styles.jobChip}>
                          <Text style={styles.jobChipText}>{row.label}</Text>
                        </View>
                        <Text
                          style={[
                            styles.pnlPct,
                            row.pct !== null &&
                              (row.pct >= 0 ? styles.netPositive : styles.netNegative),
                          ]}>
                          {row.pct !== null
                            ? `${row.pct >= 0 ? '+' : ''}${row.pct.toFixed(1)}%`
                            : '—'}
                        </Text>
                      </View>
                      <Text style={styles.pnlDetail} numberOfLines={1}>
                        {`Rev ${formatRounded(row.revenue)} · Exp ${formatRounded(row.expenses)} · ${
                          Number.isInteger(row.hours) ? row.hours : row.hours.toFixed(1)
                        } h · Labor ${formatRounded(row.labor)}`}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}
            </>
          ) : null}
        </>
      )}

      {role?.isAdmin && data ? (
        <View style={styles.expensesHeaderRow}>
          <Text style={styles.sectionTitle}>Expenses</Text>
          <Pressable
            onPress={() => {
              setStatus(null);
              setFormOpen((open) => !open);
            }}
            style={({ pressed }) => [styles.newButton, pressed && styles.buttonPressed]}>
            <Text style={styles.newButtonText}>{formOpen ? 'Close' : '+ Add expense'}</Text>
          </Pressable>
        </View>
      ) : null}

      {formOpen && role?.isAdmin && data ? (
        <View style={styles.formCard}>
          <Text style={styles.fieldLabel}>Amount ($)</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            placeholder="0.00"
            placeholderTextColor={colors.inkSoft}
            keyboardType="decimal-pad"
          />
          <Text style={styles.fieldLabel}>Description</Text>
          <TextInput
            style={styles.input}
            value={description}
            onChangeText={setDescription}
            placeholder="What was this for?"
            placeholderTextColor={colors.inkSoft}
          />
          <Text style={styles.fieldLabel}>Paid to (optional)</Text>
          <TextInput
            style={styles.input}
            value={paidTo}
            onChangeText={setPaidTo}
            placeholder="Vendor or store"
            placeholderTextColor={colors.inkSoft}
          />
          <Text style={styles.fieldLabel}>Date (YYYY-MM-DD)</Text>
          <TextInput
            style={styles.input}
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {jobOptions.length > 0 ? (
            <>
              <Text style={styles.fieldLabel}>Job (optional)</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={styles.jobPickerRow}>
                  <Pressable
                    onPress={() => setJobId(null)}
                    style={[styles.pickChip, jobId === null && styles.pickChipActive]}>
                    <Text
                      style={[
                        styles.pickChipText,
                        jobId === null && styles.pickChipTextActive,
                      ]}>
                      Company
                    </Text>
                  </Pressable>
                  {jobOptions.map((option) => (
                    <Pressable
                      key={option.id}
                      onPress={() => setJobId(option.id)}
                      style={[styles.pickChip, jobId === option.id && styles.pickChipActive]}>
                      <Text
                        style={[
                          styles.pickChipText,
                          jobId === option.id && styles.pickChipTextActive,
                        ]}>
                        {option.label}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
            </>
          ) : null}
          <Pressable
            onPress={() => void saveExpense()}
            disabled={saving}
            style={({ pressed }) => [
              styles.sunButton,
              (pressed || saving) && styles.buttonPressed,
            ]}>
            {saving ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <>
                <Ionicons name="pricetag" size={16} color={colors.ink} />
                <Text style={styles.sunButtonText}>Record expense</Text>
              </>
            )}
          </Pressable>
        </View>
      ) : null}

      {status ? (
        <Text
          style={[
            styles.statusText,
            status.kind === 'error' ? styles.statusError : styles.statusSuccess,
          ]}>
          {status.message}
        </Text>
      ) : null}

    </View>
  );

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.container}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ocean}
          />
        }
        ListHeaderComponent={header}
        renderSectionHeader={({ section }) => {
          const open = openMonths.has(section.key);
          return (
            <Pressable
              onPress={() => toggleMonth(section.key)}
              style={({ pressed }) => [styles.monthHeader, pressed && styles.buttonPressed]}>
              <View style={styles.monthLabelRow}>
                <Ionicons
                  name={open ? 'chevron-down' : 'chevron-forward'}
                  size={15}
                  color={colors.inkSoft}
                />
                <Text style={styles.monthLabel}>{section.label}</Text>
                <Text style={styles.monthCount}>
                  ({section.entries.length})
                </Text>
              </View>
              <Text style={styles.monthTotal}>{formatMoney(section.total)}</Text>
            </Pressable>
          );
        }}
        renderItem={renderRow}
        ListEmptyComponent={
          loaded && role?.isAdmin && data ? (
            <View style={styles.placeholderCard}>
              <Ionicons name="pricetag" size={22} color={colors.inkSoft} />
              <Text style={styles.placeholderText}>
                No expenses recorded yet. Add the first one above.
              </Text>
            </View>
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xl,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  title: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
  },
  newButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...shadows.card,
  },
  newButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  overviewCard: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  overviewGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.md,
  },
  overviewTile: {
    width: '50%',
    gap: 2,
    paddingRight: spacing.sm,
  },
  tileLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  tileValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  netPositive: {
    color: colors.success,
  },
  netNegative: {
    color: colors.danger,
  },
  tileLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  profitSublabel: {
    color: colors.inkSoft,
    fontSize: 10,
  },
  profitValue: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  jobPickerRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  pickChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  pickChipActive: {
    backgroundColor: colors.ocean,
  },
  pickChipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  pickChipTextActive: {
    color: colors.white,
  },
  sunButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 4,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    ...shadows.card,
  },
  sunButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  saveEditButton: {
    flexGrow: 0,
    paddingHorizontal: spacing.lg,
    marginTop: 0,
  },
  buttonPressed: {
    opacity: 0.7,
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
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  monthHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  monthLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  monthCount: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  expensesHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    marginBottom: spacing.xs,
  },
  sectionToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    paddingVertical: spacing.xs,
  },
  sectionTitleInline: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    flex: 1,
  },
  sectionToggleHint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  pnlCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    marginBottom: spacing.sm,
    ...shadows.card,
  },
  pnlRow: {
    padding: spacing.md,
    gap: 4,
  },
  pnlRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  pnlTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  pnlPct: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  pnlDetail: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  monthLabel: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  monthTotal: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  rowCard: {
    backgroundColor: colors.white,
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
    borderTopColor: colors.tan,
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
    gap: spacing.sm,
  },
  jobChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  jobChipText: {
    color: colors.ocean,
    fontSize: 11,
    fontWeight: '800',
  },
  metaText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  amountText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
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
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
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
    marginBottom: spacing.sm,
  },
  statusError: {
    color: colors.danger,
  },
  statusSuccess: {
    color: colors.ocean,
  },
});
