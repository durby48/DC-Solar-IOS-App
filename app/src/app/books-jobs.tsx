import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';

import { JobPicker, type JobOption } from '@/components/financials/ExpenseLedger';
import { formatMoney } from '@/components/financials/format';
import { AppText, Button, Card, Chip, EmptyState, Screen, SectionHeader, WheelPickerSheet } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';
import { formatShortDate } from '@/lib/dates';
import * as haptics from '@/lib/haptics';
import { fetchPipelineJobs } from '@/lib/pipeline';
import {
  assignLineToJob,
  confirmAppMatches,
  fetchUntaggedLines,
  markLineOverhead,
  previewAppMatches,
  type AccountChoice,
  type MatchResult,
  type UntaggedLine,
} from '@/lib/qboBooks';
import { isCompanyJob } from '@/lib/stages';

/**
 * `/books-jobs` (2026-11-21) — Systems Management → Expenses needing a job.
 *
 * QuickBooks is the system of record and Devon tags every new expense to a
 * job himself (here or in QuickBooks — both write the same QuickBooks
 * transaction). Two lists:
 *
 *   1. App receipts that fit a Chase-feed transaction — confirm and the
 *      receipt's job is stamped on that transaction (no new transaction, so
 *      no duplicate).
 *   2. QuickBooks expense lines with no job, or still Uncategorized — pick a
 *      job (or Overhead) and, if needed, the account. A hint shows what the
 *      app thinks; it is never applied by itself.
 */

const lineKey = (l: UntaggedLine) => `${l.type}:${l.id}:${l.lineId}`;

export default function BooksJobsScreen() {
  const gate = useAdminOnlyScreen();
  const [lines, setLines] = useState<UntaggedLine[] | null>(null);
  const [accounts, setAccounts] = useState<AccountChoice[]>([]);
  const [matches, setMatches] = useState<MatchResult | null>(null);
  const [jobOptions, setJobOptions] = useState<JobOption[]>([]);
  const [companyJobId, setCompanyJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | 'all' | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [u, m, j] = await Promise.all([fetchUntaggedLines('2026-06-26'), previewAppMatches(), fetchPipelineJobs()]);
    if (u.ok) {
      setLines(u.value.lines);
      setAccounts(u.value.accounts);
    } else setError(u.message);
    if (m.ok) setMatches(m.value);
    const container = j.jobs.find((x) => isCompanyJob(x)) ?? null;
    setCompanyJobId(container?.id ?? null);
    setJobOptions(
      j.jobs
        .filter((x) => x.id !== container?.id)
        .map((x) => ({ id: x.id, label: x.job_number ?? x.name, customerName: x.customer?.name ?? null, address: x.address })),
    );
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (gate.phase === 'ready' && gate.isAdmin) void load();
    }, [gate.phase, gate.isAdmin, load]),
  );

  const confirm = async (keys: string[], tag: string | 'all') => {
    setConfirming(tag);
    const res = await confirmAppMatches(keys);
    setConfirming(null);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    haptics.success?.();
    void load();
  };

  const matchable = matches?.matched ?? [];
  const jobLabel = useMemo(() => new Map(jobOptions.map((o) => [o.id, o.label])), [jobOptions]);

  if (gate.blocked) return null;

  return (
    <Screen edges={[]} refreshing={loading && !!lines} onRefresh={() => void load()} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Expenses needing a job' }} />

      {error ? (
        <Card style={styles.errorCard}>
          <AppText variant="bodyStrong">QuickBooks said no</AppText>
          <AppText variant="caption" color={colors.textSecondary}>{error}</AppText>
        </Card>
      ) : null}

      {!lines && !error ? <ActivityIndicator color={hubColors.systems.fg} style={styles.loading} /> : null}

      {matchable.length || matches?.ambiguous.length ? (
        <>
          <SectionHeader
            title="App receipts → bank lines"
            subtitle="Same amount, within 5 days. Confirm to stamp the job on QuickBooks' own transaction."
            icon="git-compare"
            action={matchable.length > 1 ? { label: confirming === 'all' ? 'Working…' : 'Confirm all', onPress: () => void confirm(matchable.map((m) => m.key), 'all') } : undefined}
          />
          <Card padded={false}>
            {matchable.map((m) => (
              <View key={m.key} style={styles.row}>
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" numberOfLines={1}>{m.description ?? 'Receipt'}</AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    App {formatShortDate(m.date)} · bank {formatShortDate(m.qboDate)} · {m.action === 'would tag' ? 'adds the job' : 'already has a job in QuickBooks'}
                  </AppText>
                </View>
                <AppText variant="numeric">{formatMoney(m.total)}</AppText>
                <Button
                  label={confirming === m.key ? '…' : 'Confirm'}
                  size="sm"
                  disabled={confirming !== null}
                  onPress={() => void confirm([m.key], m.key)}
                />
              </View>
            ))}
            {(matches?.ambiguous ?? []).map((m) => (
              <View key={m.key} style={styles.row}>
                <Ionicons name="help-circle" size={18} color={colors.amber} />
                <View style={styles.flex}>
                  <AppText variant="bodyStrong" numberOfLines={1}>{m.description ?? 'Receipt'}</AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    {formatShortDate(m.date)} · two bank lines fit — match this one in QuickBooks
                  </AppText>
                </View>
                <AppText variant="numeric">{formatMoney(m.total)}</AppText>
              </View>
            ))}
          </Card>
          {matches?.waiting.length ? (
            <AppText variant="caption" color={colors.textMuted}>
              {matches.waiting.length} more app receipt{matches.waiting.length === 1 ? ' is' : 's are'} waiting for the bank feed. Accept the Chase lines in QuickBooks and they show up here.
            </AppText>
          ) : null}
        </>
      ) : null}

      {lines ? (
        <>
          <SectionHeader
            title="QuickBooks expenses with no job"
            subtitle={`${lines.length} line${lines.length === 1 ? '' : 's'} · pick a job or Overhead`}
            icon="pricetags"
          />
          {lines.length ? (
            lines.map((l) => (
              <LineCard
                key={lineKey(l)}
                line={l}
                open={open === lineKey(l)}
                onToggle={() => setOpen((cur) => (cur === lineKey(l) ? null : lineKey(l)))}
                jobOptions={jobOptions}
                companyJobId={companyJobId}
                jobLabel={jobLabel}
                accounts={accounts}
                onSaved={() => {
                  setOpen(null);
                  setLines((cur) => cur?.filter((x) => lineKey(x) !== lineKey(l)) ?? null);
                }}
                onError={setError}
              />
            ))
          ) : (
            <EmptyState icon="checkmark-done" title="All caught up" body="Every QuickBooks expense is on a job or marked overhead." />
          )}
        </>
      ) : null}
    </Screen>
  );
}

function LineCard({
  line,
  open,
  onToggle,
  jobOptions,
  companyJobId,
  jobLabel,
  accounts,
  onSaved,
  onError,
}: {
  line: UntaggedLine;
  open: boolean;
  onToggle: () => void;
  jobOptions: JobOption[];
  companyJobId: string | null;
  jobLabel: Map<string, string>;
  accounts: AccountChoice[];
  onSaved: () => void;
  onError: (m: string) => void;
}) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [pickAccount, setPickAccount] = useState(false);
  const [saving, setSaving] = useState(false);
  const overhead = jobId !== null && jobId === companyJobId;
  const accountName = accounts.find((a) => a.id === accountId)?.name;
  const needsAccount = line.uncategorized && !accountId;

  const save = async () => {
    if (!jobId || needsAccount) return;
    setSaving(true);
    const res = overhead
      ? await markLineOverhead(line, accountId ?? undefined)
      : await assignLineToJob(line, jobId, accountId ?? undefined);
    setSaving(false);
    if (!res.ok) onError(res.message);
    else {
      haptics.success?.();
      onSaved();
    }
  };

  return (
    <Card style={styles.lineCard}>
      <Pressable onPress={onToggle} style={styles.lineHead}>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" numberOfLines={1}>{line.payee ?? line.memo ?? line.account}</AppText>
          <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
            {formatShortDate(line.date)} · {line.account}
            {line.hasJob ? ' · on a job, needs a category' : ''}
            {line.memo && line.payee ? ` · ${line.memo}` : ''}
          </AppText>
        </View>
        <AppText variant="numeric">{formatMoney(line.amount)}</AppText>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
      </Pressable>

      {open ? (
        <View style={styles.editor}>
          {line.suggestion ? (
            <Chip
              icon="bulb"
              tone="sun"
              label={`Hint: ${line.suggestion.jobNumber ?? jobLabel.get(line.suggestion.jobId) ?? 'job'} — ${line.suggestion.why}`}
              selected={jobId === line.suggestion.jobId}
              onPress={() => setJobId(line.suggestion!.jobId)}
            />
          ) : null}
          {!line.hasJob ? (
            <JobPicker label="Job" options={jobOptions} companyJobId={companyJobId} selected={jobId} onSelect={setJobId} />
          ) : null}
          <Pressable onPress={() => setPickAccount(true)} style={styles.accountRow}>
            <AppText variant="caption" color={colors.textMuted}>Account</AppText>
            <AppText variant="body" color={needsAccount ? colors.amber : colors.textPrimary} style={styles.flex} numberOfLines={1}>
              {accountName ?? (line.uncategorized ? 'Pick one (required)' : `${line.account} (keep, or a job-cost twin when moved to a job)`)}
            </AppText>
            <Ionicons name="chevron-forward" size={14} color={colors.textMuted} />
          </Pressable>
          <Button
            label={saving ? 'Saving to QuickBooks…' : overhead ? 'Save as overhead' : 'Save to job'}
            disabled={saving || (!jobId && !line.hasJob) || needsAccount}
            onPress={() => {
              if (line.hasJob && !jobId && companyJobId) {
                // Already on a job in QuickBooks: only the category changes.
                setSaving(true);
                void markLineOverhead(line, accountId ?? undefined).then((res) => {
                  setSaving(false);
                  if (!res.ok) onError(res.message);
                  else onSaved();
                });
                return;
              }
              void save();
            }}
          />
          <WheelPickerSheet
            visible={pickAccount}
            title="Account"
            options={accounts.map((a) => ({ value: a.id, label: `${a.jobCost ? 'Job · ' : ''}${a.name}` }))}
            value={accountId ?? accounts[0]?.id ?? ''}
            onChange={(v) => setAccountId(v)}
            onClose={() => setPickAccount(false)}
          />
        </View>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { gap: spacing.md, paddingBottom: spacing.xxl },
  flex: { flex: 1 },
  loading: { marginTop: spacing.xl },
  errorCard: { gap: spacing.xs, borderColor: colors.danger, borderWidth: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  lineCard: { gap: spacing.sm },
  lineHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  editor: { gap: spacing.sm },
  accountRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xs },
});

export { ScreenErrorBoundary as ErrorBoundary } from '@/components/ScreenErrorBoundary';
