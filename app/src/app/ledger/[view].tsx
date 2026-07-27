import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from 'expo-router';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { getDocumentUrl } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import {
  generateContractPdf,
  setJobContractValue,
  updateFinanceEntry,
} from '@/lib/documents';
import { fetchFinancials, type LedgerEntry } from '@/lib/financials';
import { type Job } from '@/lib/mockData';
import { shareDocument, viewDocument } from '@/lib/pdf';
import { CONTRACTED_STAGES, fetchPipelineJobs } from '@/lib/pipeline';
import { useRole } from '@/lib/role';
import { stageOrDefault, type Stage } from '@/lib/stages';

/**
 * Company-wide ledger drill-downs, reached from the Financials tab's
 * pipeline-mirror tiles:
 *   /ledger/estimates  — every estimate, grouped per job, with its PDF
 *   /ledger/invoices   — every invoice, grouped per job, with its PDF;
 *                        active/completed + period filters
 *   /ledger/contracted — every job currently under contract + its value
 *   /ledger/paid       — every payment received, grouped per job
 * Admin-only (the underlying finance query returns null otherwise).
 */

type ViewKey = 'estimates' | 'invoices' | 'contracted' | 'paid';

const VIEW_TITLES: Record<ViewKey, string> = {
  estimates: 'All estimates',
  invoices: 'All invoices',
  contracted: 'Jobs under contract',
  paid: 'Payments received',
};

const ENTRY_TYPE: Record<Exclude<ViewKey, 'contracted'>, LedgerEntry['type']> = {
  estimates: 'estimate',
  invoices: 'invoice',
  paid: 'payment',
};

type Period = 'all' | 'month' | 'quarter' | 'ytd';
const PERIODS: { key: Period; label: string }[] = [
  { key: 'all', label: 'All time' },
  { key: 'month', label: 'This month' },
  { key: 'quarter', label: 'This quarter' },
  { key: 'ytd', label: 'Year to date' },
];

type JobStatusFilter = 'all' | 'active' | 'completed';
const JOB_STATUS: { key: JobStatusFilter; label: string }[] = [
  { key: 'all', label: 'All jobs' },
  { key: 'active', label: 'Active' },
  { key: 'completed', label: 'Completed' },
];

function inPeriod(dateISO: string | null, period: Period): boolean {
  if (period === 'all') return true;
  if (!dateISO) return false;
  const now = new Date().toISOString().slice(0, 10);
  if (period === 'month') return dateISO.slice(0, 7) === now.slice(0, 7);
  if (period === 'ytd') return dateISO.slice(0, 4) === now.slice(0, 4);
  // quarter
  if (dateISO.slice(0, 4) !== now.slice(0, 4)) return false;
  const q = (m: string) => Math.floor((Number(m) - 1) / 3);
  return q(dateISO.slice(5, 7)) === q(now.slice(5, 7));
}

function formatMoney(amount: number): string {
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

interface JobInfo {
  id: string;
  label: string; // job number or name
  name: string;
  customer: string | null;
  customerId: string | null;
  stage: Stage;
  /** Full fetched job row — needed for contract PDF generation. */
  raw: Job;
}

interface JobGroup {
  key: string; // job id or 'company'
  job: JobInfo | null; // null = company-level entries (no job)
  entries: LedgerEntry[];
  subtotal: number;
}

export default function LedgerScreen() {
  const params = useLocalSearchParams<{ view?: string }>();
  const view: ViewKey = (
    ['estimates', 'invoices', 'contracted', 'paid'] as ViewKey[]
  ).includes(params.view as ViewKey)
    ? (params.view as ViewKey)
    : 'estimates';
  const router = useRouter();
  const role = useRole();

  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [jobs, setJobs] = useState<Map<string, JobInfo>>(new Map());
  const [jobOrder, setJobOrder] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  const [jobStatus, setJobStatus] = useState<JobStatusFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Inline contract-value editing (contracted view).
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [genContract, setGenContract] = useState(true);
  const [savingContract, setSavingContract] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (role?.isAdmin) {
      const [financials, { jobs: fetched, isMock }] = await Promise.all([
        fetchFinancials(),
        fetchPipelineJobs(),
      ]);
      setEntries(financials?.allEntries ?? null);
      if (!isMock) {
        const map = new Map<string, JobInfo>();
        for (const job of fetched as Job[]) {
          map.set(job.id, {
            id: job.id,
            label: job.job_number ?? job.name,
            name: job.name,
            customer: job.customer?.name ?? null,
            customerId: job.customer_id,
            stage: stageOrDefault((job as unknown as { stage?: unknown }).stage, job.status),
            raw: job,
          });
        }
        setJobs(map);
        setJobOrder(fetched.map((j) => j.id)); // pipeline order: newest job first
      }
    } else {
      setEntries(null);
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

  // Entry views: filter → group per job (pipeline order, company bucket last).
  const groups = useMemo<JobGroup[]>(() => {
    if (view === 'contracted' || !entries) return [];
    const type = ENTRY_TYPE[view];
    const filtered = entries.filter((e) => {
      if (e.type !== type) return false;
      if (!inPeriod(e.occurred_on, period)) return false;
      if (view === 'invoices' && jobStatus !== 'all') {
        const stage = e.job_id ? jobs.get(e.job_id)?.stage : undefined;
        const completed = stage === 'Complete';
        if (jobStatus === 'active' && (completed || !stage)) return false;
        if (jobStatus === 'completed' && !completed) return false;
      }
      return true;
    });
    const byJob = new Map<string, JobGroup>();
    for (const entry of filtered) {
      const key = entry.job_id ?? 'company';
      const group = byJob.get(key) ?? {
        key,
        job: entry.job_id ? (jobs.get(entry.job_id) ?? null) : null,
        entries: [],
        subtotal: 0,
      };
      group.entries.push(entry);
      group.subtotal += entry.amount;
      byJob.set(key, group);
    }
    const ordered: JobGroup[] = [];
    for (const id of jobOrder) {
      const group = byJob.get(id);
      if (group) ordered.push(group);
    }
    // Jobs not in the fetched list (deleted?) then the company bucket last.
    for (const [key, group] of byJob) {
      if (key !== 'company' && !jobOrder.includes(key)) ordered.push(group);
    }
    const company = byJob.get('company');
    if (company) ordered.push(company);
    return ordered;
  }, [view, entries, jobs, jobOrder, period, jobStatus]);

  // Contracted view: jobs in a contracted stage + their contract (invoice) value.
  const contractedJobs = useMemo(() => {
    if (view !== 'contracted' || !entries) return [];
    const invoiceTotals = new Map<string, number>();
    for (const e of entries) {
      if (e.type === 'invoice' && e.job_id) {
        invoiceTotals.set(e.job_id, (invoiceTotals.get(e.job_id) ?? 0) + e.amount);
      }
    }
    return jobOrder
      .map((id) => jobs.get(id))
      .filter((job): job is JobInfo => !!job && CONTRACTED_STAGES.includes(job.stage))
      .map((job) => ({ job, value: invoiceTotals.get(job.id) ?? 0 }));
  }, [view, entries, jobs, jobOrder]);

  const total =
    view === 'contracted'
      ? contractedJobs.reduce((sum, row) => sum + row.value, 0)
      : groups.reduce((sum, g) => sum + g.subtotal, 0);
  const count =
    view === 'contracted'
      ? contractedJobs.length
      : groups.reduce((sum, g) => sum + g.entries.length, 0);

  const openPdf = async (entry: LedgerEntry) => {
    if (!entry.document_path) return;
    setError(null);
    const url = await getDocumentUrl(entry.document_path);
    if (!url || !(await viewDocument(url))) {
      setError('Could not open the PDF. Please try again.');
    }
  };

  const saveContractValue = async (job: JobInfo) => {
    const target = Number(editValue.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(target) || target < 0) {
      setError('Enter a contract value of zero or more.');
      return;
    }
    setSavingContract(true);
    setError(null);
    setStatusMsg(null);
    const result = await setJobContractValue({
      jobId: job.id,
      customerId: job.customerId,
      target,
    });
    if (!result.ok) {
      setSavingContract(false);
      setError(result.message);
      return;
    }

    let message = 'Contract value saved.';
    if (genContract && target > 0 && Platform.OS !== 'web') {
      const generated = await generateContractPdf({ job: job.raw, target });
      if (generated.ok) {
        if (result.entryId) {
          await updateFinanceEntry(result.entryId, {
            document_number: generated.documentNumber,
            document_path: generated.storagePath,
          });
        }
        message = `Contract value saved — ${generated.documentNumber}.pdf generated.`;
      } else {
        message = `Contract value saved, but the contract PDF failed: ${generated.message}`;
      }
    } else if (genContract && Platform.OS === 'web') {
      message = 'Contract value saved. Generate the contract PDF from the iOS app.';
    }

    setSavingContract(false);
    setEditingJobId(null);
    setStatusMsg(message);
    await load();
  };

  const sharePdf = async (entry: LedgerEntry) => {
    if (!entry.document_path) return;
    setError(null);
    setBusyId(entry.id);
    try {
      const url = await getDocumentUrl(entry.document_path);
      if (!url || !(await shareDocument(url, `${entry.document_number ?? 'document'}.pdf`))) {
        setError('Could not share the PDF. Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  };

  const chipRow = (
    options: { key: string; label: string }[],
    selected: string,
    onPick: (key: never) => void,
  ) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipScroll}>
      <View style={styles.chipRow}>
        {options.map((option) => {
          const active = selected === option.key;
          return (
            <Pressable
              key={option.key}
              onPress={() => onPick(option.key as never)}
              style={[styles.chip, active && styles.chipActive]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );

  const renderEntry = (entry: LedgerEntry, index: number) => (
    <View key={entry.id} style={[styles.entryRow, index > 0 && styles.rowBorderTop]}>
      <Pressable
        onPress={() => void openPdf(entry)}
        disabled={!entry.document_path}
        style={({ pressed }) => [
          styles.entryBody,
          pressed && entry.document_path != null && styles.rowPressed,
        ]}>
        <View style={styles.entryText}>
          <Text style={styles.entryTitle} numberOfLines={1}>
            {entry.document_number ??
              entry.description ??
              (entry.type === 'payment' ? 'Payment' : 'Entry')}
          </Text>
          <Text style={styles.entryMeta}>
            {formatShortDate(entry.occurred_on)}
            {view === 'paid' && entry.counterparty ? ` · ${entry.counterparty}` : ''}
          </Text>
        </View>
        <Text style={styles.entryAmount}>{formatMoney(entry.amount)}</Text>
      </Pressable>
      {entry.document_path ? (
        <Pressable
          onPress={() => void sharePdf(entry)}
          disabled={busyId !== null}
          hitSlop={6}
          style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
          {busyId === entry.id ? (
            <ActivityIndicator size="small" color={colors.ocean} />
          ) : (
            <Ionicons name="share-outline" size={15} color={colors.ocean} />
          )}
        </Pressable>
      ) : null}
    </View>
  );

  const body = () => {
    if (!loaded) {
      return (
        <View style={styles.center}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      );
    }
    if (!role?.isAdmin || entries === null) {
      return (
        <View style={styles.placeholderCard}>
          <Ionicons name="lock-closed" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>
            The company ledger is available to owners and operators.
          </Text>
        </View>
      );
    }

    return (
      <>
        {view !== 'contracted' ? chipRow(PERIODS, period, setPeriod as never) : null}
        {view === 'invoices' ? chipRow(JOB_STATUS, jobStatus, setJobStatus as never) : null}

        <View style={styles.totalCard}>
          <Text style={styles.totalLabel}>
            {count} {view === 'contracted' ? (count === 1 ? 'job' : 'jobs') : count === 1 ? 'entry' : 'entries'}
          </Text>
          <Text style={styles.totalValue}>{formatMoney(total)}</Text>
        </View>
        {view === 'estimates' ? (
          <Text style={styles.footnote}>
            The Estimates tile counts each job's most recent estimate only; this list shows
            every estimate written.
          </Text>
        ) : null}

        {error ? <Text style={styles.errorText}>{error}</Text> : null}
        {statusMsg ? <Text style={styles.statusText}>{statusMsg}</Text> : null}

        {view === 'contracted'
          ? contractedJobs.map(({ job, value }) => {
              const editing = editingJobId === job.id;
              return (
                <View key={job.id} style={styles.jobCard}>
                  <Pressable
                    onPress={() =>
                      router.push({ pathname: '/job/[id]', params: { id: job.id } })
                    }
                    style={({ pressed }) => [pressed && styles.pressed]}>
                    <View style={styles.jobCardHeader}>
                      <View style={styles.jobChip}>
                        <Text style={styles.jobChipText}>{job.label}</Text>
                      </View>
                      <Text style={styles.stageText}>{job.stage}</Text>
                    </View>
                    <Text style={styles.jobName}>{job.name}</Text>
                    {job.customer ? (
                      <Text style={styles.jobCustomer}>{job.customer}</Text>
                    ) : null}
                  </Pressable>
                  <View style={styles.valueRow}>
                    <Text style={styles.jobValue}>Contract value {formatMoney(value)}</Text>
                    <Pressable
                      onPress={() => {
                        setError(null);
                        setStatusMsg(null);
                        if (editing) {
                          setEditingJobId(null);
                        } else {
                          setEditingJobId(job.id);
                          setEditValue(value > 0 ? String(value) : '');
                          setGenContract(true);
                        }
                      }}
                      hitSlop={6}
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                      <Ionicons name="pencil" size={15} color={colors.ocean} />
                    </Pressable>
                  </View>
                  {editing ? (
                    <View style={styles.editCard}>
                      <Text style={styles.editLabel}>Contract value ($)</Text>
                      <TextInput
                        style={styles.editInput}
                        value={editValue}
                        onChangeText={setEditValue}
                        placeholder="0.00"
                        placeholderTextColor={colors.inkSoft}
                        keyboardType="decimal-pad"
                      />
                      <Pressable
                        onPress={() => setGenContract((on) => !on)}
                        style={({ pressed }) => [styles.toggleRow, pressed && styles.pressed]}>
                        <Ionicons
                          name={genContract ? 'checkbox' : 'square-outline'}
                          size={18}
                          color={colors.ocean}
                        />
                        <Text style={styles.toggleText}>Generate contract PDF</Text>
                      </Pressable>
                      <Text style={styles.toggleHint}>
                        Creates {job.label}-Contract.pdf in the job's documents. Turn off for
                        historical jobs where you upload the signed contract instead.
                      </Text>
                      <View style={styles.editButtons}>
                        <Pressable
                          onPress={() => setEditingJobId(null)}
                          disabled={savingContract}
                          hitSlop={8}>
                          <Text style={styles.cancelText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void saveContractValue(job)}
                          disabled={savingContract}
                          style={({ pressed }) => [
                            styles.saveButton,
                            (pressed || savingContract) && styles.pressed,
                          ]}>
                          {savingContract ? (
                            <ActivityIndicator color={colors.ink} />
                          ) : (
                            <Text style={styles.saveButtonText}>Save</Text>
                          )}
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })
          : groups.map((group) => (
              <View key={group.key} style={styles.groupWrap}>
                <Pressable
                  onPress={() =>
                    group.job
                      ? router.push({ pathname: '/job/[id]', params: { id: group.job.id } })
                      : undefined
                  }
                  style={({ pressed }) => [
                    styles.groupHeader,
                    pressed && group.job != null && styles.pressed,
                  ]}>
                  <View style={styles.groupHeaderText}>
                    <Text style={styles.groupTitle} numberOfLines={1}>
                      {group.job ? group.job.label : 'Company (no job)'}
                      {group.job?.customer ? ` — ${group.job.customer}` : ''}
                    </Text>
                    {group.job && group.job.name !== group.job.label ? (
                      <Text style={styles.groupSub} numberOfLines={1}>
                        {group.job.name}
                      </Text>
                    ) : null}
                  </View>
                  <Text style={styles.groupTotal}>{formatMoney(group.subtotal)}</Text>
                </Pressable>
                <View style={styles.groupCard}>{group.entries.map(renderEntry)}</View>
              </View>
            ))}

        {count === 0 ? (
          <View style={styles.placeholderCard}>
            <Ionicons name="file-tray" size={22} color={colors.inkSoft} />
            <Text style={styles.placeholderText}>Nothing here for this filter.</Text>
          </View>
        ) : null}
      </>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: VIEW_TITLES[view] }} />
      <ScrollView
        style={styles.safe}
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
        }>
        {body()}
      </ScrollView>
    </>
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
  center: {
    paddingVertical: spacing.xxl,
    alignItems: 'center',
  },
  chipScroll: {
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  chip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  chipActive: {
    backgroundColor: colors.ocean,
  },
  chipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  chipTextActive: {
    color: colors.white,
  },
  totalCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.sunLight,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    marginBottom: spacing.sm,
  },
  totalLabel: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  totalValue: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  footnote: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: spacing.sm,
  },
  groupWrap: {
    marginBottom: spacing.md,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  groupHeaderText: {
    flex: 1,
  },
  groupTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  groupSub: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  groupTotal: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  groupCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.sm,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  entryBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  entryText: {
    flex: 1,
    gap: 2,
  },
  entryTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  entryMeta: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  entryAmount: {
    color: colors.ink,
    fontSize: 14,
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
  pressed: {
    opacity: 0.7,
  },
  jobCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  jobCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  jobChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  jobChipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  stageText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  jobName: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '700',
  },
  jobCustomer: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  jobValue: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  placeholderCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  placeholderText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  statusText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: spacing.sm,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  editCard: {
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.xs,
    marginTop: spacing.xs,
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
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  toggleText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '700',
  },
  toggleHint: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '600',
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
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.card,
  },
  saveButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
});
