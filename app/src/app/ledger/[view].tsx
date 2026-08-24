import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { JobPicker } from '@/components/financials/ExpenseLedger';
import { Field } from '@/components/forms/Field';
import { StatusPill } from '@/components/StatusPill';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  CountUp,
  EmptyState,
  FadeInUp,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { getDocumentUrl } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import {
  deleteFinanceEntry,
  generateContractPdf,
  setJobContractValue,
  updateFinanceEntry,
} from '@/lib/documents';
import { fetchFinancials, type LaborRun, type LedgerEntry } from '@/lib/financials';
import * as haptics from '@/lib/haptics';
import { type Job } from '@/lib/types';
import { shareDocument, viewDocument } from '@/lib/pdf';
import { CONTRACTED_STAGES, fetchPipelineJobs } from '@/lib/pipeline';
import { isCompanyJob } from '@/lib/stages';
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

type ViewKey =
  | 'estimates'
  | 'invoices'
  | 'invoiced-active'
  | 'invoiced-ytd'
  | 'contracted'
  | 'contracted-ytd'
  | 'paid'
  | 'labor';

const VIEW_TITLES: Record<ViewKey, string> = {
  estimates: 'All estimates',
  invoices: 'All invoices',
  'invoiced-active': 'Actively invoiced',
  'invoiced-ytd': 'Invoiced YTD',
  contracted: 'Actively contracted',
  'contracted-ytd': 'Contracted YTD',
  paid: 'Payments received',
  labor: 'Labor by month',
};

const ENTRY_TYPE: Record<
  Exclude<ViewKey, 'contracted' | 'contracted-ytd' | 'labor'>,
  LedgerEntry['type']
> = {
  estimates: 'estimate',
  invoices: 'invoice',
  'invoiced-active': 'invoice',
  'invoiced-ytd': 'invoice',
  paid: 'payment',
};

/** Job stages each stage-scoped view accepts (null = no stage restriction). */
const VIEW_STAGES: Partial<Record<ViewKey, readonly Stage[]>> = {
  'invoiced-active': ['Pending Payment'],
  'invoiced-ytd': ['Pending Payment', 'Complete'],
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
    [
      'estimates',
      'invoices',
      'invoiced-active',
      'invoiced-ytd',
      'contracted',
      'contracted-ytd',
      'paid',
      'labor',
    ] as ViewKey[]
  ).includes(params.view as ViewKey)
    ? (params.view as ViewKey)
    : 'estimates';
  const router = useRouter();
  const role = useRole();

  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [laborRuns, setLaborRuns] = useState<LaborRun[]>([]);
  const [laborEstimate, setLaborEstimate] = useState(0);
  const [jobs, setJobs] = useState<Map<string, JobInfo>>(new Map());
  const [jobOrder, setJobOrder] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  const [jobStatus, setJobStatus] = useState<JobStatusFilter>('all');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Two-tap delete, same pattern as the expense ledger: first tap arms the
  // row, the second actually deletes.
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // "Assign to job" — moving a scanner-filed payment (usually parked on the
  // Company container) onto the project it actually paid for.
  const [assignId, setAssignId] = useState<string | null>(null);
  const [assignJobId, setAssignJobId] = useState<string | null>(null);
  const [savingAssign, setSavingAssign] = useState(false);
  // Inline contract-value editing (contracted view).
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [genContract, setGenContract] = useState(true);
  const [savingContract, setSavingContract] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (role?.isAdmin) {
      const [financials, { jobs: fetched }] = await Promise.all([
        fetchFinancials(),
        fetchPipelineJobs(),
      ]);
      setEntries(financials?.allEntries ?? null);
      setLaborRuns(financials?.laborRuns ?? []);
      setLaborEstimate(financials?.laborUnpaidEstimate ?? 0);
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
    if (view === 'contracted' || view === 'contracted-ytd' || view === 'labor' || !entries)
      return [];
    const type = ENTRY_TYPE[view];
    const stages = VIEW_STAGES[view];
    const filtered = entries.filter((e) => {
      if (e.type !== type) return false;
      if (!inPeriod(e.occurred_on, period)) return false;
      if (stages) {
        // Stage-scoped views: keep only entries on jobs in those stages.
        const stage = e.job_id ? jobs.get(e.job_id)?.stage : undefined;
        if (!stage || !stages.includes(stage)) return false;
      }
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

  // Contracted views: jobs by stage + their contract (invoice) value.
  // 'contracted' = actively contracted stages only; 'contracted-ytd' keeps
  // the job through Pending Payment and Complete — the whole lifecycle.
  const contractedJobs = useMemo(() => {
    if ((view !== 'contracted' && view !== 'contracted-ytd') || !entries) return [];
    const stages: readonly Stage[] =
      view === 'contracted'
        ? CONTRACTED_STAGES
        : [...CONTRACTED_STAGES, 'Pending Payment', 'Complete'];
    const invoiceTotals = new Map<string, number>();
    for (const e of entries) {
      if (e.type === 'invoice' && e.job_id) {
        invoiceTotals.set(e.job_id, (invoiceTotals.get(e.job_id) ?? 0) + e.amount);
      }
    }
    return jobOrder
      .map((id) => jobs.get(id))
      .filter((job): job is JobInfo => !!job && stages.includes(job.stage))
      .map((job) => ({ job, value: invoiceTotals.get(job.id) ?? 0 }));
  }, [view, entries, jobs, jobOrder]);

  /** job key ('company' for no job) -> sum of payments received. */
  const paidByJob = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of entries ?? []) {
      if (e.type !== 'payment') continue;
      const key = e.job_id ?? 'company';
      map.set(key, (map.get(key) ?? 0) + e.amount);
    }
    return map;
  }, [entries]);

  /**
   * What a job is expected to collect - the basis the PAID view compares
   * payments against: the invoiced total when any invoice exists, else the
   * newest estimate's amount. (Estimate/invoice rows compare against their
   * own amount instead.)
   */
  const dueByJob = useMemo(() => {
    const invoiced = new Map<string, number>();
    const newestEstimate = new Map<string, { amount: number; when: string }>();
    for (const e of entries ?? []) {
      if (!e.job_id) continue;
      if (e.type === 'invoice') {
        invoiced.set(e.job_id, (invoiced.get(e.job_id) ?? 0) + e.amount);
      } else if (e.type === 'estimate') {
        const when = `${e.occurred_on ?? ''}|${e.created_at ?? ''}`;
        const prev = newestEstimate.get(e.job_id);
        if (!prev || when >= prev.when) newestEstimate.set(e.job_id, { amount: e.amount, when });
      }
    }
    const map = new Map<string, number>();
    for (const [id, v] of newestEstimate) map.set(id, v.amount);
    for (const [id, v] of invoiced) map.set(id, v);
    return map;
  }, [entries]);

  /**
   * Payment status for one row: green + checked box when the JOB has paid the
   * row's figure in full, otherwise how much has arrived (even $0). Null for
   * the company bucket and for zero bases, where "paid in full" is undefined.
   */
  const paymentStatus = (
    entry: LedgerEntry,
    jobKey: string,
  ): { full: boolean; paid: number; basis: number } | null => {
    if (jobKey === 'company') return null;
    const basis = entry.type === 'payment' ? (dueByJob.get(jobKey) ?? 0) : entry.amount;
    if (!(basis > 0)) return null;
    const paid = paidByJob.get(jobKey) ?? 0;
    return { full: paid >= basis - 0.005, paid, basis };
  };

  /** Payroll runs grouped by payday month, newest month first. */
  const laborMonths = useMemo(() => {
    if (view !== 'labor') return [];
    const byMonth = new Map<string, LaborRun[]>();
    for (const run of laborRuns) {
      const ym = run.payday.slice(0, 7);
      byMonth.set(ym, [...(byMonth.get(ym) ?? []), run]);
    }
    return [...byMonth.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([ym, runs]) => ({
        ym,
        label: new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        }),
        runs: runs.sort((a, b) => b.payday.localeCompare(a.payday)),
        total: runs.reduce((sum, r) => sum + r.totalWithdrawn, 0),
      }));
  }, [view, laborRuns]);

  const jobCardView = view === 'contracted' || view === 'contracted-ytd';
  const total =
    view === 'labor'
      ? laborRuns.reduce((sum, r) => sum + r.totalWithdrawn, 0) + laborEstimate
      : jobCardView
        ? contractedJobs.reduce((sum, row) => sum + row.value, 0)
        : groups.reduce((sum, g) => sum + g.subtotal, 0);
  const count =
    view === 'labor'
      ? laborRuns.length
      : jobCardView
        ? contractedJobs.length
        : groups.reduce((sum, g) => sum + g.entries.length, 0);

  // `entry.revision` busts the CDN / Safari cache: a revision overwrites the
  // same storage object, so the previous signed URL's bytes are still valid.
  const openPdf = async (entry: LedgerEntry) => {
    if (!entry.document_path) return;
    setError(null);
    const url = await getDocumentUrl(entry.document_path, entry.revision);
    if (!url || !(await viewDocument(url))) {
      setError('Could not open the PDF. Please try again.');
    }
  };

  /**
   * Estimates and invoices with a document number are real paperwork: they
   * open in the builder, where the numbers and the PDF move together. Payments
   * and the document-less "Contract value" rows have nothing to re-render and
   * keep the editors they already had.
   */
  const reviseEntry = (entry: LedgerEntry) => {
    router.push({
      pathname: '/document-builder',
      params: { entryId: entry.id, ...(entry.job_id ? { jobId: entry.job_id } : {}) },
    });
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

    haptics.success();
    setSavingContract(false);
    setEditingJobId(null);
    setStatusMsg(message);
    await load();
  };

  /** Job options for the assign picker: Company first, then pipeline order. */
  const companyJobId = useMemo(
    () => jobOrder.find((jid) => isCompanyJob(jobs.get(jid)?.raw ?? null)) ?? null,
    [jobOrder, jobs],
  );
  const assignOptions = useMemo(
    () =>
      jobOrder
        .filter((jid) => jid !== companyJobId)
        .map((jid) => ({ id: jid, label: jobs.get(jid)?.label ?? 'Job' })),
    [jobOrder, jobs, companyJobId],
  );

  const saveAssign = async (entry: LedgerEntry) => {
    setSavingAssign(true);
    setError(null);
    const result = await updateFinanceEntry(entry.id, { job_id: assignJobId });
    setSavingAssign(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    haptics.success();
    setAssignId(null);
    await load();
  };

  const pressDelete = async (entry: LedgerEntry) => {
    if (confirmDeleteId !== entry.id) {
      setConfirmDeleteId(entry.id);
      return;
    }
    setDeletingId(entry.id);
    setError(null);
    const result = await deleteFinanceEntry(entry.id);
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (result.ok) {
      haptics.success();
      await load();
    } else {
      setError(result.message);
    }
  };

  const sharePdf = async (entry: LedgerEntry) => {
    if (!entry.document_path) return;
    setError(null);
    setBusyId(entry.id);
    try {
      const url = await getDocumentUrl(entry.document_path, entry.revision);
      if (!url || !(await shareDocument(url, `${entry.document_number ?? 'document'}.pdf`))) {
        setError('Could not share the PDF. Please try again.');
      }
    } finally {
      setBusyId(null);
    }
  };

  /**
   * A filter row. `Chip` carries the selection haptic and the fill-not-outline
   * selected state, so the row reads at arm's length on a roof.
   */
  const chipRow = (
    options: { key: string; label: string }[],
    selected: string,
    onPick: (key: never) => void,
  ) => (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.chipRow}>
        {options.map((option) => (
          <Chip
            key={option.key}
            label={option.label}
            tone="olive"
            selected={selected === option.key}
            onPress={() => onPick(option.key as never)}
          />
        ))}
      </View>
    </ScrollView>
  );

  const renderEntry = (entry: LedgerEntry, index: number, jobKey: string) => {
    const revision = entry.revision ?? 1;
    const revisable =
      (entry.type === 'estimate' || entry.type === 'invoice') && entry.document_number != null;
    const stale = entry.document_meta?.pdf_state === 'stale';
    const status = paymentStatus(entry, jobKey);
    const confirming = confirmDeleteId === entry.id;
    const busyDelete = deletingId === entry.id;
    const assigning = assignId === entry.id;
    return (
      <View
        style={[
          styles.entryRow,
          index > 0 && styles.rowBorderTop,
          status?.full && styles.entryRowPaid,
        ]}>
        <AnimatedPressable
          onPress={() => void openPdf(entry)}
          disabled={!entry.document_path}
          haptic="tapLight"
          scaleTo={0.99}
          accessibilityRole="button"
          accessibilityLabel={entry.document_number ?? 'Open PDF'}
          style={styles.entryBody}>
          <View style={styles.entryText}>
            <AppText variant="bodyStrong" numberOfLines={1}>
              {entry.document_number ??
                entry.description ??
                (entry.type === 'payment' ? 'Payment' : 'Entry')}
              {revision > 1 ? ` · rev ${revision}` : ''}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {formatShortDate(entry.occurred_on)}
              {view === 'paid' && entry.counterparty ? ` · ${entry.counterparty}` : ''}
            </AppText>
            {stale ? (
              <Chip label="PDF out of date" icon="warning" tone="danger" style={styles.staleChip} />
            ) : null}
            {status ? (
              status.full ? (
                <View style={styles.paidRow}>
                  <Ionicons name="checkbox" size={14} color={colors.mintDeep} />
                  <AppText variant="caption" color={colors.mintDeep}>
                    Paid in full
                  </AppText>
                </View>
              ) : (
                <View style={styles.paidRow}>
                  <Ionicons name="square-outline" size={14} color={colors.textMuted} />
                  <AppText variant="caption" color={colors.textMuted}>
                    {`${formatMoney(status.paid)} of ${formatMoney(status.basis)} paid`}
                  </AppText>
                </View>
              )
            ) : null}
          </View>
          <AppText variant="bodyStrong" style={styles.figure}>
            {formatMoney(entry.amount)}
          </AppText>
        </AnimatedPressable>

        {revisable ? (
          <AnimatedPressable
            onPress={() => reviseEntry(entry)}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Revise document"
            style={styles.iconButton}>
            <Ionicons name="pencil" size={15} color={colors.accentPrimary} />
          </AnimatedPressable>
        ) : null}

        {entry.type === 'payment' ? (
          <AnimatedPressable
            onPress={() => {
              setError(null);
              if (assigning) {
                setAssignId(null);
              } else {
                setAssignId(entry.id);
                setAssignJobId(entry.job_id);
              }
            }}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Assign payment to a job"
            style={styles.iconButton}>
            <Ionicons name="swap-horizontal" size={15} color={colors.accentPrimary} />
          </AnimatedPressable>
        ) : null}

        {entry.document_path ? (
          <AnimatedPressable
            onPress={() => void sharePdf(entry)}
            disabled={busyId !== null}
            haptic="tapLight"
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Share PDF"
            style={styles.iconButton}>
            {busyId === entry.id ? (
              <ActivityIndicator size="small" color={colors.accentPrimary} />
            ) : (
              <Ionicons name="share-outline" size={15} color={colors.accentPrimary} />
            )}
          </AnimatedPressable>
        ) : null}

        <AnimatedPressable
          onPress={() => void pressDelete(entry)}
          disabled={busyDelete}
          haptic={confirming ? 'warn' : 'tapLight'}
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
    );
  };

  /** The inline "assign to job" panel, rendered under an assigning row. */
  const renderAssignPanel = (entry: LedgerEntry) => (
    <View style={styles.assignPanel}>
      <AppText variant="caption" color={colors.textMuted}>
        Move this {formatMoney(entry.amount)} payment onto the project it paid for. The job's
        paid-in-full checks and the P&L follow it.
      </AppText>
      <JobPicker
        label="Job"
        options={assignOptions}
        companyJobId={companyJobId}
        selected={assignJobId}
        onSelect={setAssignJobId}
      />
      <View style={styles.assignButtons}>
        <Button
          label="Cancel"
          variant="ghost"
          size="sm"
          disabled={savingAssign}
          onPress={() => setAssignId(null)}
        />
        <Button
          label="Move payment"
          size="sm"
          loading={savingAssign}
          disabled={savingAssign || assignJobId === undefined}
          onPress={() => void saveAssign(entry)}
        />
      </View>
    </View>
  );

  const body = () => {
    if (!loaded) {
      return <SkeletonList count={5} height={92} />;
    }
    if (!role?.isAdmin || entries === null) {
      return (
        <Card>
          <EmptyState
            icon="lock-closed"
            title="The company ledger is available to owners and operators."
          />
        </Card>
      );
    }

    return (
      <>
        {!jobCardView && view !== 'labor' ? chipRow(PERIODS, period, setPeriod as never) : null}
        {view === 'invoices' ? chipRow(JOB_STATUS, jobStatus, setJobStatus as never) : null}

        <Card style={styles.totalCard}>
          <AppText variant="section" color={colors.ink}>
            {count}{' '}
            {view === 'labor'
              ? count === 1
                ? 'payroll'
                : 'payrolls'
              : jobCardView
                ? count === 1
                  ? 'job'
                  : 'jobs'
                : count === 1
                  ? 'entry'
                  : 'entries'}
          </AppText>
          <CountUp value={total} prefix="$" decimals={2} style={styles.totalValue} />
        </Card>

        {view === 'estimates' ? (
          <AppText variant="caption" color={colors.textMuted}>
            The Estimates tile counts each job's most recent estimate only; this list shows every
            estimate written.
          </AppText>
        ) : null}

        {error ? (
          <AppText variant="caption" color={colors.danger} align="center">
            {error}
          </AppText>
        ) : null}
        {statusMsg ? (
          <AppText variant="caption" color={colors.accentPrimary} align="center">
            {statusMsg}
          </AppText>
        ) : null}

        {view === 'labor' ? (
          <>
            {laborEstimate > 0 ? (
              <Card tone="sunk">
                <AppText variant="bodyStrong">
                  Current period — accruing {formatMoney(laborEstimate)}
                </AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Estimate: hours logged since the last recorded run × rate × employer taxes.
                  Becomes exact when the run is recorded on the Hours tab.
                </AppText>
              </Card>
            ) : null}
            {laborMonths.map((month, index) => (
              <FadeInUp key={month.ym} index={index} style={styles.groupWrap}>
                <View style={styles.groupHeader}>
                  <SectionHeader
                    title={month.label}
                    subtitle={`${month.runs.length} ${month.runs.length === 1 ? 'payroll' : 'payrolls'}`}
                    style={styles.groupSection}
                  />
                  <AppText variant="bodyStrong" color={colors.textMuted} style={styles.figure}>
                    {formatMoney(month.total)}
                  </AppText>
                </View>
                <Card padded={false}>
                  {month.runs.map((run, j) => (
                    <View key={run.payday} style={[styles.entryRow, j > 0 && styles.rowBorderTop]}>
                      <View style={styles.entryBody}>
                        <View style={styles.entryText}>
                          <AppText variant="bodyStrong">
                            {`Payroll — paid ${formatShortDate(run.payday)}`}
                          </AppText>
                          <AppText variant="caption" color={colors.textMuted}>
                            {`period ${formatShortDate(run.periodStart)} – ${formatShortDate(run.periodEnd)}`}
                          </AppText>
                        </View>
                        <AppText variant="bodyStrong" style={styles.figure}>
                          {formatMoney(run.totalWithdrawn)}
                        </AppText>
                      </View>
                    </View>
                  ))}
                </Card>
              </FadeInUp>
            ))}
          </>
        ) : jobCardView
          ? contractedJobs.map(({ job, value }, index) => {
              const editing = editingJobId === job.id;
              const paid = paidByJob.get(job.id) ?? 0;
              const fullyPaid = value > 0 && paid >= value - 0.005;
              return (
                <FadeInUp key={job.id} index={index}>
                  <Card style={[styles.jobCard, fullyPaid && styles.jobCardPaid]}>
                    <AnimatedPressable
                      onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
                      haptic="tapLight"
                      scaleTo={0.995}
                      accessibilityRole="button"
                      accessibilityLabel={job.name}>
                      <View style={styles.jobCardHeader}>
                        <Chip label={job.label} tone="olive" />
                        <StatusPill stage={job.stage} />
                      </View>
                      <AppText variant="heading" style={styles.jobName}>
                        {job.name}
                      </AppText>
                      {job.customer ? (
                        <AppText variant="caption" color={colors.textMuted}>
                          {job.customer}
                        </AppText>
                      ) : null}
                    </AnimatedPressable>

                    <View style={styles.valueRow}>
                      <View style={styles.contractValueWrap}>
                        <AppText
                          variant="bodyStrong"
                          color={colors.oliveDeep}
                          style={styles.figure}>
                          Contract value {formatMoney(value)}
                        </AppText>
                        {value > 0 ? (
                          <View style={styles.paidRow}>
                            <Ionicons
                              name={fullyPaid ? 'checkbox' : 'square-outline'}
                              size={14}
                              color={fullyPaid ? colors.mintDeep : colors.textMuted}
                            />
                            <AppText
                              variant="caption"
                              color={fullyPaid ? colors.mintDeep : colors.textMuted}>
                              {fullyPaid
                                ? 'Paid in full'
                                : `${formatMoney(paid)} of ${formatMoney(value)} paid`}
                            </AppText>
                          </View>
                        ) : null}
                      </View>
                      <AnimatedPressable
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
                        haptic="tapLight"
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel="Edit contract value"
                        style={styles.iconButton}>
                        <Ionicons name="pencil" size={15} color={colors.accentPrimary} />
                      </AnimatedPressable>
                    </View>

                    {editing ? (
                      <Card tone="sunk" style={styles.editCard}>
                        <Field
                          label="Contract value ($)"
                          value={editValue}
                          onChangeText={setEditValue}
                          placeholder="0.00"
                          keyboardType="decimal-pad"
                        />
                        <AnimatedPressable
                          onPress={() => setGenContract((on) => !on)}
                          haptic="tapLight"
                          scaleTo={0.99}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: genContract }}
                          accessibilityLabel="Generate contract PDF"
                          style={styles.toggleRow}>
                          <Ionicons
                            name={genContract ? 'checkbox' : 'square-outline'}
                            size={18}
                            color={colors.accentPrimary}
                          />
                          <AppText variant="bodyStrong" color={colors.accentPrimary}>
                            Generate contract PDF
                          </AppText>
                        </AnimatedPressable>
                        <AppText variant="caption" color={colors.textMuted}>
                          Creates {job.label}-Contract.pdf in the job's documents. Turn off for
                          historical jobs where you upload the signed contract instead.
                        </AppText>
                        <View style={styles.editButtons}>
                          <Button
                            label="Cancel"
                            variant="ghost"
                            size="sm"
                            disabled={savingContract}
                            onPress={() => setEditingJobId(null)}
                          />
                          <Button
                            label="Save"
                            size="sm"
                            loading={savingContract}
                            disabled={savingContract}
                            onPress={() => void saveContractValue(job)}
                          />
                        </View>
                      </Card>
                    ) : null}
                  </Card>
                </FadeInUp>
              );
            })
          : groups.map((group, index) => (
              <FadeInUp key={group.key} index={index} style={styles.groupWrap}>
                <AnimatedPressable
                  onPress={() =>
                    group.job
                      ? router.push({ pathname: '/job/[id]', params: { id: group.job.id } })
                      : undefined
                  }
                  disabled={!group.job}
                  haptic="tapLight"
                  scaleTo={0.995}
                  accessibilityRole="button"
                  accessibilityLabel={group.job ? group.job.label : 'Company (no job)'}
                  style={styles.groupHeader}>
                  <SectionHeader
                    title={`${group.job ? group.job.label : 'Company (no job)'}${
                      group.job?.customer ? ` — ${group.job.customer}` : ''
                    }`}
                    subtitle={
                      group.job && group.job.name !== group.job.label ? group.job.name : undefined
                    }
                    style={styles.groupSection}
                  />
                  <AppText variant="bodyStrong" color={colors.textMuted} style={styles.figure}>
                    {formatMoney(group.subtotal)}
                  </AppText>
                </AnimatedPressable>
                <Card padded={false}>
                  {group.entries.map((entry, i) => (
                    <View key={entry.id}>
                      {renderEntry(entry, i, group.key)}
                      {assignId === entry.id ? renderAssignPanel(entry) : null}
                    </View>
                  ))}
                </Card>
              </FadeInUp>
            ))}

        {count === 0 ? (
          <Card>
            <EmptyState
              icon="file-tray"
              title="Nothing here for this filter."
              body="Change the period or job filter above to widen the search."
            />
          </Card>
        ) : null}
      </>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: VIEW_TITLES[view] }} />
      <Screen edges={[]} refreshing={refreshing} onRefresh={onRefresh}>
        {body()}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  chipRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  totalCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.sunLight,
  },
  totalValue: {
    fontSize: 18,
    lineHeight: 23,
  },
  groupWrap: {
    marginTop: spacing.xs,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  groupSection: {
    flex: 1,
    marginBottom: spacing.xs,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: spacing.sm,
    backgroundColor: colors.surface,
  },
  /** Soft green when the job has paid this row's figure in full. */
  entryRowPaid: {
    backgroundColor: colors.mintSoft,
  },
  jobCardPaid: {
    backgroundColor: colors.mintSoft,
  },
  paidRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginTop: 2,
  },
  contractValueWrap: {
    flex: 1,
    gap: 2,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  entryBody: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  entryText: {
    flex: 1,
    gap: 2,
  },
  staleChip: {
    marginTop: 2,
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
  assignPanel: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  assignButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
  },
  jobCard: {
    gap: spacing.xs,
  },
  jobCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  jobName: {
    marginTop: spacing.xs,
  },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  editCard: {
    marginTop: spacing.xs,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingTop: spacing.xs,
  },
  editButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
});
