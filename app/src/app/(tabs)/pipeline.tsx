import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PipelineHero } from '@/components/PipelineHero';
import { PropertyArt } from '@/components/PropertyArt';
import { StatusPill } from '@/components/StatusPill';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { type Job } from '@/lib/mockData';
import {
  fetchFinanceEntries,
  fetchMyHoursByJob,
  fetchNextDates,
  fetchPipelineJobs,
  fetchLaborHoursByJob,
  moneyByJobFromEntries,
  type JobLaborHours,
  type JobMoney,
  type NextDate,
} from '@/lib/pipeline';
import { fetchArtworkUrls } from '@/lib/artwork';
import { fetchForecastModel, forecastJob, type ForecastModel } from '@/lib/forecast';
import { useRole } from '@/lib/role';
import { STAGES, stageOrDefault, type Stage } from '@/lib/stages';
import { formatTimeLabel } from '@/lib/time';

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** jobs.stage isn't on the shared Job type yet (migration 6 may not be applied). */
function jobStage(job: Job) {
  return stageOrDefault((job as unknown as { stage?: unknown }).stage, job.status);
}

function formatHours(h: number): string {
  return `${Math.round(h)} h`;
}

/**
 * One project card. Two swipeable pages over a SHARED property-art background
 * (the art sits behind the pager, so the house doesn't slide with the text).
 *
 *   Page 1 — who and when: job number, stage, customer, address, next date.
 *   Page 2 — how much: modules, forecast hours, and the money.
 *
 * Money renders only when `money` is present, which RLS already makes
 * admin-only — crew simply get null, so this is enforced server-side rather
 * than merely hidden in the UI.
 */
function PipelineCard({
  job,
  next,
  money,
  myHours,
  artUrl,
  labor,
  model,
}: {
  job: Job;
  next: NextDate | undefined;
  money: JobMoney | undefined;
  myHours: number | undefined;
  artUrl: string | undefined;
  labor: JobLaborHours | undefined;
  model: ForecastModel | null;
}) {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const pageWidth = Math.max(240, width - spacing.lg * 2);
  const [page, setPage] = useState(0);

  const stage = jobStage(job);
  const extra = job as unknown as {
    completed_on?: string | null;
    module_count?: number | null;
    job_type?: string | null;
  };
  const completedOn = extra.completed_on ?? null;
  const time = next ? formatTimeLabel(next.start_time) : null;
  const nextLabel =
    stage === 'Complete' && completedOn
      ? `Completed ${formatShortDate(completedOn)}`
      : next
        ? `Next: ${formatShortDate(next.work_date)}${time ? ` — ${time}` : ''}`
        : 'No upcoming date';

  const modules = extra.module_count ?? null;
  const forecast = forecastJob(model, extra.job_type, modules);

  // (paid − expenses − labor) ÷ paid. Only meaningful once money came in.
  const profitPct =
    money && money.paid > 0
      ? ((money.paid - money.expenses - (labor?.labor ?? 0)) / money.paid) * 100
      : null;

  const open = () => router.push({ pathname: '/job/[id]', params: { id: job.id } });

  return (
    <View style={styles.card}>
      <PropertyArt seed={job.id} imageUrl={artUrl} radius={radii.md} />
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) =>
          setPage(Math.round(event.nativeEvent.contentOffset.x / pageWidth))
        }
        style={{ width: pageWidth }}>
        {/* ---- page 1: who and when ---- */}
        <Pressable
          onPress={open}
          style={({ pressed }) => [styles.page, { width: pageWidth }, pressed && styles.cardPressed]}>
          <View style={styles.topRow}>
            {job.job_number ? (
              <View style={styles.chip}>
                <Text style={styles.chipText}>{job.job_number}</Text>
              </View>
            ) : null}
            <StatusPill stage={stage} />
          </View>
          <Text style={styles.name} numberOfLines={2}>
            {job.name}
          </Text>
          {job.customer?.name ? (
            <View style={styles.customerRow}>
              <CustomerAvatar customer={job.customer} size={26} />
              <Text style={styles.customer} numberOfLines={1}>
                {job.customer.name}
              </Text>
            </View>
          ) : null}
          {job.address ? <Text style={styles.address}>{job.address}</Text> : null}
          <Text
            style={
              (stage === 'Complete' && completedOn) || next ? styles.nextDate : styles.noDate
            }>
            {nextLabel}
          </Text>
          {myHours !== undefined && myHours > 0 ? (
            <Text style={styles.hoursRow}>{`Your hours: ${myHours.toFixed(1)} h`}</Text>
          ) : null}
        </Pressable>

        {/* ---- page 2: how much ---- */}
        <Pressable
          onPress={open}
          style={({ pressed }) => [styles.page, { width: pageWidth }, pressed && styles.cardPressed]}>
          <View style={styles.topRow}>
            {job.job_number ? (
              <View style={styles.chip}>
                <Text style={styles.chipText}>{job.job_number}</Text>
              </View>
            ) : null}
            {extra.job_type ? (
              <View style={styles.typeChip}>
                <Text style={styles.typeChipText}>{extra.job_type}</Text>
              </View>
            ) : null}
          </View>

          <View style={styles.statRow}>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Modules</Text>
              <Text style={styles.statValue}>{modules ?? '—'}</Text>
            </View>
            <View style={styles.stat}>
              <Text style={styles.statLabel}>Est. hours</Text>
              <Text style={styles.statValue}>
                {forecast ? formatHours(forecast.hours) : '—'}
              </Text>
            </View>
          </View>
          {forecast ? (
            <Text style={styles.forecastNote}>
              {forecast.low !== null && forecast.high !== null
                ? `${formatHours(forecast.low)}–${formatHours(forecast.high)} · from ${forecast.samples} finished ${forecast.basis} jobs`
                : `from 1 finished ${forecast.basis} job — treat as rough`}
            </Text>
          ) : (
            <Text style={styles.forecastNote}>
              {modules ? 'No finished jobs to forecast from yet' : 'Set a module count to forecast'}
            </Text>
          )}

          {money ? (
            <>
              <View style={styles.moneyRowNew}>
                {([
                  ['Est', money.estimate !== null ? formatCurrency(money.estimate) : '—'],
                  ['Inv', formatCurrency(money.invoiced)],
                  ['Paid', formatCurrency(money.paid)],
                ] as [string, string][]).map(([label, value]) => (
                  <View key={label} style={styles.moneyCell}>
                    <Text style={styles.statLabel}>{label}</Text>
                    <Text style={styles.moneyValue}>{value}</Text>
                  </View>
                ))}
              </View>
              <View style={styles.profitRowNew}>
                <Text style={styles.statLabel}>Profit</Text>
                <Text
                  style={[
                    styles.profitValueNew,
                    profitPct !== null &&
                      (profitPct >= 0 ? styles.profitPositive : styles.profitNegative),
                  ]}>
                  {profitPct !== null
                    ? `${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`
                    : '—'}
                </Text>
              </View>
            </>
          ) : null}
        </Pressable>
      </ScrollView>

      <View style={styles.dots} pointerEvents="none">
        {[0, 1].map((i) => (
          <View key={i} style={[styles.dot, page === i && styles.dotActive]} />
        ))}
      </View>
    </View>
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
  const [labor, setLabor] = useState<Map<string, JobLaborHours> | null>(null);
  const [model, setModel] = useState<ForecastModel | null>(null);
  const [myHours, setMyHours] = useState<Map<string, number>>(new Map());
  const [stageFilter, setStageFilter] = useState<Stage | 'All' | 'Active'>('All');
  const [artUrls, setArtUrls] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    const { jobs: fetched, isMock: mock } = await fetchPipelineJobs();
    setJobs(fetched);
    setIsMock(mock);
    setNextDates(await fetchNextDates(mock));
    setArtUrls(mock ? new Map() : await fetchArtworkUrls());
    setModel(mock ? null : await fetchForecastModel());

    if (!mock && role?.isAdmin) {
      // One finance fetch feeds both the per-card money rows and the
      // company totals header; both hide when it fails.
      const financeRows = await fetchFinanceEntries();
      setMoney(financeRows ? moneyByJobFromEntries(financeRows) : null);
      setLabor(await fetchLaborHoursByJob());
      setMyHours(new Map());
    } else if (!mock && role) {
      setMoney(null);
      setLabor(null);
      setMyHours(
        await fetchMyHoursByJob({ email: role.email, displayName: role.displayName }),
      );
    } else {
      // Signed out / demo mode: no money, labor, or hours rows.
      setMoney(null);
      setLabor(null);
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

  const stageCounts = useMemo(() => {
    const counts = new Map<Stage, number>();
    for (const job of jobs) {
      const stage = jobStage(job);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return counts;
  }, [jobs]);

  const filteredJobs = useMemo(() => {
    if (stageFilter === 'All') return jobs;
    if (stageFilter === 'Active') return jobs.filter((job) => jobStage(job) !== 'Complete');
    return jobs.filter((job) => jobStage(job) === stageFilter);
  }, [jobs, stageFilter]);

  const filterChips: (Stage | 'All' | 'Active')[] = ['All', 'Active', ...STAGES];

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <FlatList
        data={filteredJobs}
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
            <PipelineHero />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.filterScroll}>
              <View style={styles.filterRow}>
                {filterChips.map((chip) => {
                  const active = stageFilter === chip;
                  const count =
                    chip === 'All'
                      ? jobs.length
                      : chip === 'Active'
                        ? jobs.length - (stageCounts.get('Complete') ?? 0)
                        : (stageCounts.get(chip) ?? 0);
                  return (
                    <Pressable
                      key={chip}
                      onPress={() => setStageFilter(chip)}
                      style={[styles.filterChip, active && styles.filterChipActive]}>
                      <Text
                        style={[
                          styles.filterChipText,
                          active && styles.filterChipTextActive,
                        ]}>
                        {`${chip} (${count})`}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </ScrollView>
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.cardWrap}>
            <PipelineCard
              job={item}
              next={nextDates.get(item.id)}
              money={money?.get(item.id)}
              myHours={myHours.get(item.id)}
              artUrl={artUrls.get(item.id)}
              labor={labor?.get(item.id)}
              model={model}
            />
          </View>
        )}
        ListEmptyComponent={
          loaded ? (
            <Text style={styles.empty}>
              {stageFilter === 'All'
                ? 'No projects yet.'
                : stageFilter === 'Active'
                  ? 'No active projects.'
                  : `No projects in ${stageFilter}.`}
            </Text>
          ) : null
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
  filterScroll: {
    marginBottom: spacing.md,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  filterChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  filterChipActive: {
    backgroundColor: colors.ocean,
  },
  filterChipText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  filterChipTextActive: {
    color: colors.white,
  },
  cardWrap: {
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    // The property artwork is an absolutely-positioned sibling underneath;
    // `overflow: hidden` keeps it inside the rounded corners.
    overflow: 'hidden',
    minHeight: 150,
    ...shadows.card,
  },
  cardPressed: {
    opacity: 0.8,
  },
  page: {
    padding: spacing.md,
    gap: spacing.xs,
    minHeight: 150,
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  typeChip: {
    backgroundColor: colors.violetSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  typeChipText: {
    color: colors.violetDeep,
    fontSize: 12,
    fontWeight: '800',
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.lg,
    marginTop: spacing.xs,
  },
  stat: {
    gap: 2,
  },
  statLabel: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  statValue: {
    color: colors.ink,
    fontSize: 22,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  forecastNote: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
  },
  moneyRowNew: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
  },
  moneyCell: {
    gap: 2,
  },
  moneyValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  profitRowNew: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  profitValueNew: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  profitPositive: {
    color: colors.success,
  },
  profitNegative: {
    color: colors.danger,
  },
  dots: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    gap: 4,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(61,53,46,0.22)',
  },
  dotActive: {
    backgroundColor: colors.ocean,
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
