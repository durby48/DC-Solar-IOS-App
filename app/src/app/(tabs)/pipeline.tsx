import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { StatusPill } from '@/components/StatusPill';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { type Job } from '@/lib/mockData';
import {
  fetchCompanyTotals,
  fetchFinanceEntries,
  fetchMyHoursByJob,
  fetchNextDates,
  fetchPipelineJobs,
  moneyByJobFromEntries,
  type CompanyTotals,
  type JobMoney,
  type NextDate,
} from '@/lib/pipeline';
import { useRole } from '@/lib/role';
import { stageOrDefault } from '@/lib/stages';
import { formatTimeLabel } from '@/lib/time';

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** jobs.stage isn't on the shared Job type yet (migration 6 may not be applied). */
function jobStage(job: Job) {
  return stageOrDefault((job as unknown as { stage?: unknown }).stage, job.status);
}

function TotalsHeader({ totals }: { totals: CompanyTotals }) {
  const pnl = totals.avgPnlPct;
  return (
    <View style={styles.totalsCard}>
      <View style={styles.totalsTile}>
        <Text style={styles.totalsLabel}>Estimates</Text>
        <Text style={styles.totalsValue} numberOfLines={1} adjustsFontSizeToFit>
          {formatCurrency(totals.estimates)}
        </Text>
      </View>
      <View style={styles.totalsTile}>
        <Text style={styles.totalsLabel}>Invoiced</Text>
        <Text style={styles.totalsValue} numberOfLines={1} adjustsFontSizeToFit>
          {formatCurrency(totals.invoiced)}
        </Text>
      </View>
      <View style={styles.totalsTile}>
        <Text style={styles.totalsLabel}>Paid</Text>
        <Text style={styles.totalsValue} numberOfLines={1} adjustsFontSizeToFit>
          {formatCurrency(totals.paid)}
        </Text>
      </View>
      <View style={styles.totalsTile}>
        <Text style={styles.totalsLabel}>Avg P&L</Text>
        <Text
          style={[
            styles.totalsValue,
            pnl !== null && pnl < 0 && styles.totalsValueNegative,
          ]}
          numberOfLines={1}
          adjustsFontSizeToFit>
          {pnl !== null ? `${pnl.toFixed(1)}%` : '—'}
        </Text>
        <Text style={styles.totalsSublabel}>paid − expenses − labor</Text>
      </View>
    </View>
  );
}

function PipelineCard({
  job,
  next,
  money,
  myHours,
}: {
  job: Job;
  next: NextDate | undefined;
  money: JobMoney | undefined;
  myHours: number | undefined;
}) {
  const router = useRouter();
  const time = next ? formatTimeLabel(next.start_time) : null;
  const nextLabel = next
    ? `Next: ${formatShortDate(next.work_date)}${time ? ` — ${time}` : ''}`
    : 'No upcoming date';

  return (
    <Pressable
      onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
      <View style={styles.topRow}>
        {job.job_number ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{job.job_number}</Text>
          </View>
        ) : null}
        <StatusPill stage={jobStage(job)} />
      </View>
      <Text style={styles.name}>{job.name}</Text>
      {job.customer?.name ? <Text style={styles.customer}>{job.customer.name}</Text> : null}
      {job.address ? <Text style={styles.address}>{job.address}</Text> : null}
      <Text style={next ? styles.nextDate : styles.noDate}>{nextLabel}</Text>
      {money ? (
        <Text style={styles.moneyRow}>
          {`Est ${money.estimate !== null ? formatCurrency(money.estimate) : '—'} · Inv ${formatCurrency(money.invoiced)} · Paid ${formatCurrency(money.paid)}`}
        </Text>
      ) : null}
      {myHours !== undefined && myHours > 0 ? (
        <Text style={styles.hoursRow}>{`Your hours: ${myHours.toFixed(1)} h`}</Text>
      ) : null}
    </Pressable>
  );
}

export default function PipelineScreen() {
  const router = useRouter();
  const role = useRole();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nextDates, setNextDates] = useState<Map<string, NextDate>>(new Map());
  const [money, setMoney] = useState<Map<string, JobMoney> | null>(null);
  const [totals, setTotals] = useState<CompanyTotals | null>(null);
  const [myHours, setMyHours] = useState<Map<string, number>>(new Map());

  const load = useCallback(async () => {
    const { jobs: fetched, isMock: mock } = await fetchPipelineJobs();
    setJobs(fetched);
    setIsMock(mock);
    setNextDates(await fetchNextDates(mock));

    if (!mock && role?.isAdmin) {
      // One finance fetch feeds both the per-card money rows and the
      // company totals header; both hide when it fails.
      const financeRows = await fetchFinanceEntries();
      setMoney(financeRows ? moneyByJobFromEntries(financeRows) : null);
      setTotals(financeRows ? await fetchCompanyTotals(financeRows) : null);
      setMyHours(new Map());
    } else if (!mock && role) {
      setMoney(null);
      setTotals(null);
      setMyHours(
        await fetchMyHoursByJob({ email: role.email, displayName: role.displayName }),
      );
    } else {
      // Signed out / demo mode: no money, totals, or hours rows.
      setMoney(null);
      setTotals(null);
      setMyHours(new Map());
    }
    setLoaded(true);
  }, [role]);

  // Refetch on every focus (in addition to pull-to-refresh) so stage edits
  // made in the job editor show up as soon as the tab regains focus.
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

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <FlatList
        data={jobs}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.ocean}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.headerRow}>
              <Text style={styles.title}>Pipeline</Text>
              {role?.isAdmin ? (
                <Pressable
                  // The /job-editor route is a standalone screen; cast keeps
                  // this tab decoupled from its typed-route generation.
                  onPress={() => router.push('/job-editor' as never)}
                  style={({ pressed }) => [styles.newButton, pressed && styles.pressed]}>
                  <Text style={styles.newButtonText}>+ New project</Text>
                </Pressable>
              ) : null}
            </View>
            {role?.isAdmin && totals ? <TotalsHeader totals={totals} /> : null}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.cardWrap}>
            <PipelineCard
              job={item}
              next={nextDates.get(item.id)}
              money={money?.get(item.id)}
              myHours={myHours.get(item.id)}
            />
          </View>
        )}
        ListEmptyComponent={
          loaded ? <Text style={styles.empty}>No projects yet.</Text> : null
        }
        ListFooterComponent={
          isMock ? <Text style={styles.mockNote}>Showing demo data</Text> : null
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
  pressed: {
    opacity: 0.85,
  },
  totalsCard: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'flex-start',
    ...shadows.card,
  },
  totalsTile: {
    flex: 1,
    gap: 2,
    paddingRight: spacing.xs,
  },
  totalsLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  totalsValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  totalsValueNegative: {
    color: colors.danger,
  },
  totalsSublabel: {
    color: colors.inkSoft,
    fontSize: 9,
  },
  cardWrap: {
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  cardPressed: {
    opacity: 0.8,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
  chip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  chipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  name: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  customer: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
  },
  address: {
    color: colors.inkSoft,
    fontSize: 14,
  },
  nextDate: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '700',
  },
  noDate: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  moneyRow: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  hoursRow: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
  },
  empty: {
    color: colors.inkSoft,
    fontSize: 15,
    marginTop: spacing.lg,
  },
  mockNote: {
    color: colors.inkSoft,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
