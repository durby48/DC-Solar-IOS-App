import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

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
  generateContractPdf,
  setJobContractValue,
  updateFinanceEntry,
} from '@/lib/documents';
import { fetchFinancials, type LedgerEntry } from '@/lib/financials';
import * as haptics from '@/lib/haptics';
import { type Job } from '@/lib/types';
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
      const [financials, { jobs: fetched }] = await Promise.all([
        fetchFinancials(),
        fetchPipelineJobs(),
      ]);
      setEntries(financials?.allEntries ?? null);
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

  const renderEntry = (entry: LedgerEntry, index: number) => {
    const revision = entry.revision ?? 1;
    const revisable =
      (entry.type === 'estimate' || entry.type === 'invoice') && entry.document_number != null;
    const stale = entry.document_meta?.pdf_state === 'stale';
    return (
      <View key={entry.id} style={[styles.entryRow, index > 0 && styles.rowBorderTop]}>
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
      </View>
    );
  };

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
        {view !== 'contracted' ? chipRow(PERIODS, period, setPeriod as never) : null}
        {view === 'invoices' ? chipRow(JOB_STATUS, jobStatus, setJobStatus as never) : null}

        <Card style={styles.totalCard}>
          <AppText variant="section" color={colors.ink}>
            {count}{' '}
            {view === 'contracted'
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

        {view === 'contracted'
          ? contractedJobs.map(({ job, value }, index) => {
              const editing = editingJobId === job.id;
              return (
                <FadeInUp key={job.id} index={index}>
                  <Card style={styles.jobCard}>
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
                      <AppText variant="bodyStrong" color={colors.oliveDeep} style={styles.figure}>
                        Contract value {formatMoney(value)}
                      </AppText>
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
                <Card padded={false}>{group.entries.map(renderEntry)}</Card>
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
