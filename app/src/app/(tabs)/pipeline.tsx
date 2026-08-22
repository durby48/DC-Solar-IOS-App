import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  FlatList,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PipelineBoard } from '@/components/PipelineBoard';
import { PipelineHero } from '@/components/PipelineHero';
import { PropertyArt } from '@/components/PropertyArt';
import { StatusPill } from '@/components/StatusPill';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  Pill,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { type FetchStatus } from '@/lib/data';
import { formatShortDate } from '@/lib/dates';
import { type Job } from '@/lib/types';
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
import {
  COMPANY_LABEL,
  STAGES,
  STAGE_GRADIENT,
  isCompanyJob,
  labelForJob,
  stageOrDefault,
  type Stage,
} from '@/lib/stages';
import { formatTimeLabel } from '@/lib/time';

/** Below this the browser window can't show the columns usefully. */
const BOARD_MIN_WIDTH = 900;

type FilterChip = Stage | 'All' | 'Active' | typeof COMPANY_LABEL;

/**
 * The accent strip under a filter chip.
 *
 * `STAGE_GRADIENT` runs soft → saturated, and `stages.ts` is explicit that its
 * deep end is not a text ground — so the stage's colour arrives here as a
 * 3px strip under the chip rather than as the chip's fill. That is the
 * documented use for these ramps ("accent strips, progress fills"), it makes
 * the filter row read as the same colour system as the board columns, and it
 * costs the chip label nothing in contrast.
 *
 * All/Active aren't stages and get no strip; Company gets ink, the same
 * deliberately-unlike-a-stage neutral its pill uses.
 */
function stripFor(chip: FilterChip): readonly [string, string] | null {
  if (chip === 'All' || chip === 'Active') return null;
  if (chip === COMPANY_LABEL) return [colors.inkSoft, colors.ink];
  return STAGE_GRADIENT[chip];
}

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
 *
 * 2026-08-22 restyle: chrome only. The card is a `Card`, the pages are
 * `AnimatedPressable`s, the chips are `Chip`/`Pill` and the type comes from
 * `AppText` — but the structure is untouched, because the phone list is the
 * right layout on a phone and is explicitly not to change: same art sibling,
 * same paging ScrollView at the same `pageWidth`, same two pages in the same
 * order, same page dots.
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
  // The overhead container (DC-26026). It is not a project: no stage, no
  // modules, no forecast, and above all no per-job profit — its expenses are
  // company costs. Left as a normal card it once read "Profit −5,790%" because
  // a stray deposit had been filed against it. Same treatment as PipelineBoard.
  const company = isCompanyJob(job);
  const extra = job as unknown as {
    completed_on?: string | null;
    module_count?: number | null;
    job_type?: string | null;
    has_critter_guard?: boolean | null;
  };
  const completedOn = extra.completed_on ?? null;
  const time = next ? formatTimeLabel(next.start_time) : null;
  const nextLabel = company
    ? 'Company overhead — not a project'
    : stage === 'Complete' && completedOn
      ? `Completed ${formatShortDate(completedOn)}`
      : next
        ? `Next: ${formatShortDate(next.work_date)}${time ? ` — ${time}` : ''}`
        : 'No upcoming date';

  const modules = extra.module_count ?? null;
  const forecast = company ? null : forecastJob(model, extra.job_type, modules);

  // (paid − expenses − labor) ÷ paid. Only meaningful once money came in, and
  // never for the company container.
  const profitPct =
    !company && money && money.paid > 0
      ? ((money.paid - money.expenses - (labor?.labor ?? 0)) / money.paid) * 100
      : null;

  const open = () => router.push({ pathname: '/job/[id]', params: { id: job.id } });

  return (
    <Card padded={false} style={styles.card}>
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
        <AnimatedPressable
          onPress={open}
          haptic="tapLight"
          scaleTo={0.99}
          accessibilityRole="button"
          accessibilityLabel={job.job_number ? `${job.job_number} ${job.name}` : job.name}
          style={[styles.page, { width: pageWidth }]}>
          <View style={styles.topRow}>
            {job.job_number ? <Chip label={job.job_number} tone="olive" /> : null}
            <StatusPill stage={labelForJob(job)} />
          </View>
          <AppText variant="heading" numberOfLines={2}>
            {job.name}
          </AppText>
          {job.customer?.name ? (
            <View style={styles.customerRow}>
              <CustomerAvatar customer={job.customer} size={26} />
              <AppText variant="bodyStrong" color={colors.textSecondary} numberOfLines={1}>
                {job.customer.name}
              </AppText>
            </View>
          ) : null}
          {job.address ? (
            <AppText variant="body" color={colors.textSecondary}>
              {job.address}
            </AppText>
          ) : null}
          <AppText
            variant="caption"
            color={
              (stage === 'Complete' && completedOn) || next
                ? colors.accentPrimary
                : colors.textMuted
            }>
            {nextLabel}
          </AppText>
          {myHours !== undefined && myHours > 0 ? (
            <AppText variant="caption" color={colors.textSecondary}>
              {`Your hours: ${myHours.toFixed(1)} h`}
            </AppText>
          ) : null}
        </AnimatedPressable>

        {/* ---- page 2: how much ---- */}
        <AnimatedPressable
          onPress={open}
          haptic="tapLight"
          scaleTo={0.99}
          accessibilityRole="button"
          accessibilityLabel={`Money and forecast for ${job.name}`}
          style={[styles.page, { width: pageWidth }]}>
          <View style={styles.topRow}>
            {job.job_number ? <Chip label={job.job_number} tone="olive" /> : null}
            <View style={styles.typeChipRow}>
              {extra.has_critter_guard ? (
                <Pill label="Critter guard" bg={colors.limeSoft} fg={colors.limeDeep} />
              ) : null}
              {extra.job_type ? (
                <Pill label={extra.job_type} bg={colors.violetSoft} fg={colors.violetDeep} />
              ) : null}
            </View>
          </View>

          {company ? (
            // ---- company container: overhead, not a project ----
            <>
              <View style={styles.statRow}>
                <View style={styles.stat}>
                  <AppText variant="section" color={colors.textMuted} style={styles.statLabel}>
                    Overhead
                  </AppText>
                  <AppText variant="numeric">
                    {money ? formatCurrency(money.expenses) : '—'}
                  </AppText>
                </View>
                <View style={styles.stat}>
                  <AppText variant="section" color={colors.textMuted} style={styles.statLabel}>
                    Hours logged
                  </AppText>
                  <AppText variant="numeric">{labor ? formatHours(labor.hours) : '—'}</AppText>
                </View>
              </View>
              <AppText variant="caption" color={colors.textSecondary}>
                Company costs — shop, tools, insurance, software. Never charged to a job and
                never counted as job profit.
              </AppText>
              {money && money.paid > 0 ? (
                <AppText variant="caption" color={colors.coralDeep} style={styles.misfiledNote}>
                  {`⚠ ${formatCurrency(money.paid)} in payments is filed here. Company earns no revenue — assign it to its job from the payment row.`}
                </AppText>
              ) : null}
            </>
          ) : null}

          {company ? null : (
            <View style={styles.statRow}>
              <View style={styles.stat}>
                <AppText variant="section" color={colors.textMuted} style={styles.statLabel}>
                  Modules
                </AppText>
                <AppText variant="numeric">{modules ?? '—'}</AppText>
              </View>
              <View style={styles.stat}>
                <AppText variant="section" color={colors.textMuted} style={styles.statLabel}>
                  Est. hours
                </AppText>
                <AppText variant="numeric">
                  {forecast ? formatHours(forecast.hours) : '—'}
                </AppText>
              </View>
            </View>
          )}
          {company ? null : forecast ? (
            <AppText variant="caption" color={colors.textSecondary}>
              {forecast.low !== null && forecast.high !== null
                ? `${formatHours(forecast.low)}–${formatHours(forecast.high)} · from ${forecast.samples} finished ${forecast.basis} jobs`
                : `from 1 finished ${forecast.basis} job — treat as rough`}
            </AppText>
          ) : (
            <AppText variant="caption" color={colors.textSecondary}>
              {modules ? 'No finished jobs to forecast from yet' : 'Set a module count to forecast'}
            </AppText>
          )}

          {!company && money ? (
            <>
              <View style={styles.moneyRowNew}>
                {([
                  ['Est', money.estimate !== null ? formatCurrency(money.estimate) : '—'],
                  ['Inv', formatCurrency(money.invoiced)],
                  ['Paid', formatCurrency(money.paid)],
                ] as [string, string][]).map(([label, value]) => (
                  <View key={label} style={styles.moneyCell}>
                    <AppText variant="section" color={colors.textMuted} style={styles.statLabel}>
                      {label}
                    </AppText>
                    <AppText variant="bodyStrong" style={styles.numeric}>
                      {value}
                    </AppText>
                  </View>
                ))}
              </View>
              {money.estimateCount > 1 ? (
                <AppText variant="caption" color={colors.textMuted}>
                  {`Est is the newest of ${money.estimateCount} estimates`}
                </AppText>
              ) : null}
              <View style={styles.profitRowNew}>
                <AppText variant="section" color={colors.textMuted} style={styles.statLabel}>
                  Profit
                </AppText>
                <AppText
                  variant="bodyStrong"
                  color={
                    profitPct === null
                      ? colors.textPrimary
                      : profitPct >= 0
                        ? colors.success
                        : colors.danger
                  }
                  style={styles.profitValueNew}>
                  {profitPct !== null
                    ? `${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`
                    : '—'}
                </AppText>
              </View>
            </>
          ) : null}
        </AnimatedPressable>
      </ScrollView>

      <View style={styles.dots} pointerEvents="none">
        {[0, 1].map((i) => (
          <View key={i} style={[styles.dot, page === i && styles.dotActive]} />
        ))}
      </View>
    </Card>
  );
}

export default function PipelineScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const role = useRole();

  const [jobs, setJobs] = useState<Job[]>([]);
  const [status, setStatus] = useState<FetchStatus>('ok');
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [nextDates, setNextDates] = useState<Map<string, NextDate>>(new Map());
  const [money, setMoney] = useState<Map<string, JobMoney> | null>(null);
  const [labor, setLabor] = useState<Map<string, JobLaborHours> | null>(null);
  const [model, setModel] = useState<ForecastModel | null>(null);
  const [myHours, setMyHours] = useState<Map<string, number>>(new Map());
  const [stageFilter, setStageFilter] = useState<FilterChip>('All');
  const [artUrls, setArtUrls] = useState<Map<string, string>>(new Map());

  const load = useCallback(async () => {
    const { jobs: fetched, status: fetchStatus } = await fetchPipelineJobs();
    setJobs(fetched);
    setStatus(fetchStatus);
    setNextDates(await fetchNextDates());
    setArtUrls(await fetchArtworkUrls());
    setModel(await fetchForecastModel());

    if (role?.isAdmin) {
      // One finance fetch feeds both the per-card money rows and the
      // company totals header; both hide when it fails.
      const financeRows = await fetchFinanceEntries();
      setMoney(financeRows ? moneyByJobFromEntries(financeRows) : null);
      setLabor(await fetchLaborHoursByJob());
      setMyHours(new Map());
    } else if (role) {
      setMoney(null);
      setLabor(null);
      setMyHours(
        await fetchMyHoursByJob({ email: role.email, displayName: role.displayName }),
      );
    } else {
      // Signed out: no money, labor, or hours rows.
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

  // The Company container is overhead, not a project: it is deliberately kept
  // out of every stage bucket so it can't inflate a stage count or show up
  // under "Complete" — and, since 2026-08-18, out of "All" too. "All" means all
  // PROJECTS; the container lives under its own Company chip only, so it can't
  // be read as a job in the list.
  const projectJobs = useMemo(() => jobs.filter((job) => !isCompanyJob(job)), [jobs]);
  const companyJobs = useMemo(() => jobs.filter(isCompanyJob), [jobs]);

  const stageCounts = useMemo(() => {
    const counts = new Map<Stage, number>();
    for (const job of projectJobs) {
      const stage = jobStage(job);
      counts.set(stage, (counts.get(stage) ?? 0) + 1);
    }
    return counts;
  }, [projectJobs]);

  const filteredJobs = useMemo(() => {
    if (stageFilter === 'All') return projectJobs;
    if (stageFilter === COMPANY_LABEL) return companyJobs;
    if (stageFilter === 'Active')
      return projectJobs.filter((job) => jobStage(job) !== 'Complete');
    return projectJobs.filter((job) => jobStage(job) === stageFilter);
  }, [jobs, projectJobs, companyJobs, stageFilter]);

  const filterChips: FilterChip[] = [
    'All',
    'Active',
    ...STAGES,
    ...(companyJobs.length > 0 ? [COMPANY_LABEL] : []),
  ];

  const newProjectButton = role?.isAdmin ? (
    <Button
      label="New project"
      // The /job-editor route is a standalone screen; cast keeps this tab
      // decoupled from its typed-route generation.
      onPress={() => router.push('/job-editor' as never)}
      size="sm"
      icon="add"
    />
  ) : null;

  const emptyPipeline =
    status === 'unavailable' ? (
      <EmptyState
        icon="cloud-offline"
        title="Couldn't load the pipeline"
        body="Pull to retry."
      />
    ) : (
      <EmptyState
        icon="briefcase"
        title="No projects yet"
        body="New projects show up here as soon as they're created."
      />
    );

  // app.dcsolarkc.com gets a stage-column job board; iOS keeps the phone list,
  // which is the right layout on a phone and is explicitly not to change. A
  // narrow browser window also keeps the list — eight columns need real width.
  const useBoard = Platform.OS === 'web' && width >= BOARD_MIN_WIDTH;

  if (useBoard) {
    return (
      <SafeAreaView style={styles.safe} edges={['top']}>
        <ScrollView contentContainerStyle={styles.boardPage}>
          <View style={styles.boardHeader}>
            <View style={styles.headerRow}>
              <AppText variant="display">Pipeline</AppText>
              {newProjectButton}
            </View>
            <PipelineHero />
          </View>
          <PipelineBoard
            jobs={jobs}
            nextDates={nextDates}
            money={money}
            artUrls={artUrls}
            labor={labor}
            model={model}
            isAdmin={role?.isAdmin ?? false}
            onChanged={load}
          />
          {loaded && jobs.length === 0 ? emptyPipeline : null}
        </ScrollView>
      </SafeAreaView>
    );
  }

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
            tintColor={colors.accentPrimary}
            colors={[colors.accentPrimary]}
          />
        }
        ListHeaderComponent={
          <View>
            <View style={styles.headerRow}>
              <AppText variant="display">Pipeline</AppText>
              {newProjectButton}
            </View>
            <PipelineHero />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.filterScroll}>
              <View style={styles.filterRow}>
                {filterChips.map((chip) => {
                  const active = stageFilter === chip;
                  // "Active" counts projects only — the Company container is
                  // neither active work nor complete work.
                  const count =
                    chip === 'All'
                      ? projectJobs.length
                      : chip === COMPANY_LABEL
                        ? companyJobs.length
                        : chip === 'Active'
                          ? projectJobs.length - (stageCounts.get('Complete') ?? 0)
                          : (stageCounts.get(chip) ?? 0);
                  const strip = stripFor(chip);
                  return (
                    <View key={chip} style={styles.filterItem}>
                      <Chip
                        label={`${chip} (${count})`}
                        tone="olive"
                        selected={active}
                        onPress={() => setStageFilter(chip)}
                      />
                      {strip ? (
                        <LinearGradient
                          colors={strip}
                          start={{ x: 0, y: 0.5 }}
                          end={{ x: 1, y: 0.5 }}
                          style={[styles.filterStrip, !active && styles.filterStripIdle]}
                        />
                      ) : (
                        <View style={styles.filterStrip} />
                      )}
                    </View>
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
            status === 'unavailable' || jobs.length === 0 ? (
              emptyPipeline
            ) : (
              <EmptyState
                icon="funnel"
                title={
                  stageFilter === 'Active'
                    ? 'No active projects'
                    : `Nothing in ${stageFilter}`
                }
                body="Every project is in another stage right now. Pick a different filter above."
                action={{ label: 'Show all', onPress: () => setStageFilter('All') }}
              />
            )
          ) : null
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
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
  filterScroll: {
    marginBottom: spacing.md,
  },
  filterRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  filterItem: {
    gap: 4,
    alignItems: 'stretch',
  },
  filterStrip: {
    height: 3,
    borderRadius: radii.pill,
    marginHorizontal: spacing.xs,
  },
  filterStripIdle: {
    opacity: 0.45,
  },
  boardPage: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
  },
  boardHeader: {
    paddingHorizontal: spacing.lg,
  },
  cardWrap: {
    marginBottom: spacing.md,
  },
  card: {
    // The property artwork is an absolutely-positioned sibling underneath;
    // `Card`'s clip keeps it inside the rounded corners.
    minHeight: 150,
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
  typeChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
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
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 0.6,
  },
  misfiledNote: {
    marginTop: spacing.xs,
  },
  numeric: {
    fontVariant: ['tabular-nums'],
  },
  moneyRowNew: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  moneyCell: {
    gap: 2,
  },
  profitRowNew: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  profitValueNew: {
    fontSize: 18,
    lineHeight: 23,
    fontVariant: ['tabular-nums'],
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
    backgroundColor: colors.accentPrimary,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
});
