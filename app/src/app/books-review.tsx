import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { formatMoney } from '@/components/financials/format';
import { AppText, Button, Card, Chip, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing, typography } from '@/constants/theme';
import { useAdminOnlyScreen } from '@/lib/adminGate';
import {
  accountForPlacement,
  BOOK_ACCOUNTS,
  BOOK_GROUPS,
  bookLabel,
  fetchDaySuggestions,
  fetchReviewExpenses,
  fetchReviewJobs,
  saveReview,
  type BookAccount,
  type DaySuggestion,
  type ReviewExpense,
  type ReviewJob,
} from '@/lib/books';

/**
 * `/books-review` (2026-10-14) — Financials → Review for QuickBooks. Admin only.
 *
 * Every expense before it goes to QuickBooks: which job it belongs to (or
 * overhead) and which QuickBooks account. Overhead rows show where the crew
 * worked that day so a fuel stop or a hardware run can be moved onto the job.
 * Save (or "Looks right") stamps the row reviewed; the QuickBooks import
 * sends what this screen says.
 */

type Filter = 'overhead' | 'needs' | 'unreviewed' | 'all';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'overhead', label: 'Overhead' },
  { key: 'needs', label: 'Needs account' },
  { key: 'unreviewed', label: 'Not reviewed' },
  { key: 'all', label: 'All expenses' },
];
const sys = hubColors.systems;

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function monthLabel(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

export default function BooksReviewScreen() {
  const gate = useAdminOnlyScreen();
  const [rows, setRows] = useState<ReviewExpense[] | null>(null);
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [days, setDays] = useState<Map<string, DaySuggestion[]>>(new Map());
  const [filter, setFilter] = useState<Filter>('overhead');
  const [openId, setOpenId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [expenses, jobList] = await Promise.all([fetchReviewExpenses(), fetchReviewJobs()]);
    if (!expenses) {
      setLoadError('Could not load expenses.');
      setRows([]);
      return;
    }
    setRows(expenses);
    setJobs(jobList);
    if (expenses.length) {
      const dates = expenses.map((e) => e.occurredOn).sort();
      setDays(await fetchDaySuggestions(dates[0], dates[dates.length - 1]));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (gate.phase === 'ready' && gate.isAdmin) void load();
    }, [gate.phase, gate.isAdmin, load]),
  );

  const visible = useMemo(() => {
    const list = rows ?? [];
    switch (filter) {
      case 'overhead':
        return list.filter((r) => r.isOverhead);
      case 'needs':
        return list.filter((r) => r.account === 'uncategorized');
      case 'unreviewed':
        return list.filter((r) => !r.reviewedAt);
      default:
        return list;
    }
  }, [rows, filter]);

  const months = useMemo(() => {
    const map = new Map<string, ReviewExpense[]>();
    for (const r of visible) {
      const key = r.occurredOn.slice(0, 7);
      map.set(key, [...(map.get(key) ?? []), r]);
    }
    return [...map.entries()];
  }, [visible]);

  const stats = useMemo(() => {
    const list = rows ?? [];
    const overhead = list.filter((r) => r.isOverhead);
    return {
      overheadCount: overhead.length,
      overheadTotal: overhead.reduce((s, r) => s + r.amount, 0),
      needs: list.filter((r) => r.account === 'uncategorized').length,
      reviewed: list.filter((r) => r.reviewedAt).length,
      total: list.length,
    };
  }, [rows]);

  const onSaved = (id: string, patch: Partial<ReviewExpense>) => {
    setRows((current) => current?.map((r) => (r.id === id ? { ...r, ...patch } : r)) ?? null);
    setOpenId(null);
  };

  if (gate.blocked) return null;
  if (gate.phase === 'loading' || rows === null) {
    return (
      <Screen edges={[]}>
        <ActivityIndicator color={sys.fg} style={styles.loading} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Card style={styles.hero}>
        <AppText variant="caption" color={colors.textSecondary}>
          Overhead (no job)
        </AppText>
        <AppText variant="display">{formatMoney(stats.overheadTotal)}</AppText>
        <AppText variant="caption" color={colors.textSecondary}>
          {stats.overheadCount} expenses · {stats.needs} need an account · {stats.reviewed} of {stats.total} reviewed
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          Tap an expense to move it onto a job or change its QuickBooks account. Only reviewed books go to QuickBooks
          cleanly — "Looks right" confirms a row as it is.
        </AppText>
      </Card>

      <View style={styles.filters}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} selected={filter === f.key} tone="olive" onPress={() => setFilter(f.key)} />
        ))}
      </View>

      {loadError ? (
        <AppText variant="body" color={colors.danger}>
          {loadError}
        </AppText>
      ) : null}
      {visible.length === 0 ? (
        <AppText variant="body" color={colors.textMuted} style={styles.empty}>
          Nothing here.
        </AppText>
      ) : null}

      {months.map(([month, list]) => (
        <View key={month} style={styles.month}>
          <View style={styles.monthHead}>
            <AppText variant="section" color={sys.fg}>
              {monthLabel(`${month}-01`)}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {list.length} · {formatMoney(list.reduce((s, r) => s + r.amount, 0))}
            </AppText>
          </View>
          <Card padded={false}>
            {list.map((r, i) => (
              <ExpenseRow
                key={r.id}
                row={r}
                open={openId === r.id}
                divider={i < list.length - 1}
                suggestions={days.get(r.occurredOn) ?? []}
                jobs={jobs}
                onToggle={() => setOpenId(openId === r.id ? null : r.id)}
                onSaved={onSaved}
              />
            ))}
          </Card>
        </View>
      ))}

      <Button label="QuickBooks connection" variant="ghost" icon="link" onPress={() => router.push('/quickbooks' as never)} />
    </Screen>
  );
}

function ExpenseRow({
  row,
  open,
  divider,
  suggestions,
  jobs,
  onToggle,
  onSaved,
}: {
  row: ReviewExpense;
  open: boolean;
  divider: boolean;
  suggestions: DaySuggestion[];
  jobs: ReviewJob[];
  onToggle: () => void;
  onSaved: (id: string, patch: Partial<ReviewExpense>) => void;
}) {
  const top = row.isOverhead ? suggestions[0] : undefined;
  const where = row.isOverhead ? 'Overhead' : (row.job?.jobNumber ?? row.job?.name ?? 'Job');
  return (
    <View style={divider ? styles.divider : null}>
      <Pressable onPress={onToggle} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <View style={styles.rowDate}>
          <AppText variant="caption" color={colors.textMuted}>
            {shortDate(row.occurredOn)}
          </AppText>
          {row.reviewedAt ? <Ionicons name="checkmark-circle" size={16} color={colors.olive} /> : null}
        </View>
        <View style={styles.flex}>
          <AppText variant="bodyStrong" numberOfLines={1}>
            {row.merchant}
          </AppText>
          <AppText variant="caption" color={row.account === 'uncategorized' ? colors.danger : colors.textSecondary} numberOfLines={1}>
            {bookLabel(row.account)} · {where}
            {row.paidFromBank ? '' : ' · not from the bank'}
          </AppText>
          {top ? (
            <AppText variant="caption" color={colors.accentLink} numberOfLines={1}>
              Crew on {top.jobNumber ?? 'a job'} that day{top.hours ? ` (${top.hours.toFixed(1)} h)` : ' (scheduled)'}
            </AppText>
          ) : null}
        </View>
        <AppText variant="bodyStrong">{formatMoney(row.amount)}</AppText>
      </Pressable>
      {open ? <Editor row={row} suggestions={suggestions} jobs={jobs} onSaved={onSaved} /> : null}
    </View>
  );
}

function Editor({
  row,
  suggestions,
  jobs,
  onSaved,
}: {
  row: ReviewExpense;
  suggestions: DaySuggestion[];
  jobs: ReviewJob[];
  onSaved: (id: string, patch: Partial<ReviewExpense>) => void;
}) {
  const internal = jobs.find((j) => j.isInternal) ?? null;
  const [jobId, setJobId] = useState<string | null>(row.jobId);
  const [account, setAccount] = useState<BookAccount>(row.account);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const job = jobs.find((j) => j.id === jobId) ?? null;
  const onJob = !!job && !job.isInternal;

  const place = (id: string | null) => {
    setJobId(id);
    const target = jobs.find((j) => j.id === id);
    setAccount((a) => accountForPlacement(a, !!target && !target.isInternal));
  };

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return jobs
      .filter((j) => !j.isInternal && [j.jobNumber, j.name, j.customerName].some((f) => f?.toLowerCase().includes(q)))
      .slice(0, 8);
  }, [jobs, search]);

  const save = async (confirmOnly: boolean) => {
    setSaving(true);
    setError(null);
    const change = confirmOnly ? { jobId: row.jobId, account: row.account } : { jobId, account };
    const res = await saveReview(row, change);
    setSaving(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    const newJob = jobs.find((j) => j.id === change.jobId) ?? null;
    onSaved(row.id, {
      jobId: change.jobId,
      job: newJob,
      isOverhead: !newJob || newJob.isInternal,
      account: change.account,
      reviewedAt: new Date().toISOString(),
    });
  };

  const jobChip = (id: string | null, label: string, key: string) => (
    <Chip key={key} label={label} selected={jobId === id} tone="olive" onPress={() => place(id)} />
  );

  return (
    <View style={styles.editor}>
      {row.description && row.description !== row.merchant ? (
        <AppText variant="caption" color={colors.textMuted}>
          {row.description}
        </AppText>
      ) : null}

      <AppText variant="caption" color={colors.textSecondary}>
        Job
      </AppText>
      <View style={styles.chips}>
        {jobChip(internal?.id ?? null, 'Overhead', 'overhead')}
        {suggestions.slice(0, 4).map((s) => jobChip(s.jobId, `${s.jobNumber ?? 'Job'}${s.hours ? ` · ${s.hours.toFixed(1)} h` : ' · scheduled'}`, s.jobId))}
        {onJob && !suggestions.some((s) => s.jobId === jobId) ? jobChip(jobId, job?.jobNumber ?? job?.name ?? 'Job', 'current') : null}
      </View>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="Find another job (number, address, customer)"
        placeholderTextColor={colors.textMuted}
        style={styles.search}
      />
      {matches.length ? (
        <View style={styles.chips}>
          {matches.map((j) =>
            jobChip(j.id, `${j.jobNumber ?? ''} ${j.customerName ?? j.name}`.trim().slice(0, 40), `m-${j.id}`),
          )}
        </View>
      ) : null}

      <AppText variant="caption" color={colors.textSecondary}>
        QuickBooks account
      </AppText>
      {BOOK_GROUPS.map((group) => (
        <View key={group} style={styles.group}>
          <AppText variant="caption" color={colors.textMuted}>
            {group}
          </AppText>
          <View style={styles.chips}>
            {(Object.keys(BOOK_ACCOUNTS) as BookAccount[])
              .filter((k) => BOOK_ACCOUNTS[k].group === group && k !== 'uncategorized')
              .map((k) => (
                <Chip key={k} label={BOOK_ACCOUNTS[k].label} selected={account === k} tone="sun" onPress={() => setAccount(k)} />
              ))}
          </View>
        </View>
      ))}

      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
      <View style={styles.actions}>
        <Button
          label="Save"
          size="sm"
          onPress={() => void save(false)}
          loading={saving}
          disabled={account === 'uncategorized'}
        />
        {row.account !== 'uncategorized' && !row.reviewedAt ? (
          <Button label="Looks right" size="sm" variant="secondary" onPress={() => void save(true)} disabled={saving} />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { marginTop: spacing.xl },
  content: { gap: spacing.md, paddingBottom: spacing.xl },
  hero: { gap: spacing.xs },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  empty: { textAlign: 'center', marginTop: spacing.lg },
  month: { gap: spacing.sm },
  monthHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingHorizontal: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  pressed: { opacity: 0.7 },
  rowDate: { width: 48, gap: 2 },
  flex: { flex: 1, minWidth: 0 },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  editor: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  group: { gap: 4 },
  search: {
    ...typography.body,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
});
