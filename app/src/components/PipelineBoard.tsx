import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PropertyArt } from '@/components/PropertyArt';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  Pill,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { forecastJob, type ForecastModel } from '@/lib/forecast';
import { haptics } from '@/lib/haptics';
import { updateJobStage } from '@/lib/jobs';
import { type Job } from '@/lib/types';
import { type JobLaborHours, type JobMoney, type NextDate } from '@/lib/pipeline';
import {
  COMPANY_LABEL,
  LABEL_COLORS,
  STAGES,
  STAGE_GRADIENT,
  isCompanyJob,
  stageOrDefault,
  type Stage,
  type StageLabel,
} from '@/lib/stages';
import { formatTimeLabel } from '@/lib/time';

/**
 * WEB-ONLY job board (2026-08-05).
 *
 * app.dcsolarkc.com has a desk-sized window that the phone layout wastes — a
 * single narrow column of tall cards. This lays the same pipeline out as a
 * board: one column per stage, Pending Estimate on the far left through to
 * Complete on the far right, in the exact order of `STAGES` so it matches the
 * order of the filter chips on iOS.
 *
 * The iOS app deliberately does NOT use this. `(tabs)/pipeline.tsx` picks the
 * board only on web AND only above a width where eight columns are usable;
 * narrow browser windows fall back to the phone list, which is still the right
 * layout there.
 *
 * Admins can nudge a job between stages with the ‹ › buttons on a card — that
 * writes through `updateJobStage`, which touches only stage/status/completed_on.
 * Drag-and-drop was deliberately skipped: doing it properly across RN-Web and
 * touch is a lot of fragile surface area for the same outcome as two arrows.
 *
 * Each card has two faces, matching the two swipe pages of the phone card in
 * `(tabs)/pipeline.tsx`:
 *
 *   Overview — who and when: job number, next date, name, address, customer.
 *   Details  — how much: modules, job type, forecast hours, and the money.
 *
 * The phone uses a horizontal pager for this. A pager is the wrong gesture on a
 * desktop board, so the same two faces are switched by a labelled button. The
 * dots beside it mirror the phone's page dots so the two layouts read as the
 * same card.
 *
 * Money renders only when `money` is present. RLS already makes that admin-only
 * — crew get null — so the split is enforced server-side, not just hidden here.
 *
 * 2026-08-22 restyle: column headers are painted with `STAGE_GRADIENT` (see
 * `columnHeaderTone` for why the title always sits on the readable end), the
 * cards are `Card` + `AnimatedPressable`, and the ‹ › arrows are ghost
 * `Button`s. The column widths, the two faces and every write path are
 * unchanged.
 */

const COLUMN_WIDTH = 284;

type CardFace = 'overview' | 'details';

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function formatHours(h: number): string {
  return `${Math.round(h)} h`;
}

function jobStage(job: Job): Stage {
  return stageOrDefault((job as unknown as { stage?: unknown }).stage, job.status);
}

/**
 * How one column's header is painted.
 *
 * Stage columns take `STAGE_GRADIENT`, run diagonally with the saturated stop
 * held back to the bottom-right corner, so the title and the count sit on the
 * soft end where dark text is legible — `stages.ts` is explicit that the deep
 * end of these ramps is not a text ground.
 *
 * The foreground is the stage's own deep hue, which `LABEL_COLORS` already
 * carries for most stages. Two need an override, both listed in `HEADER_INK`.
 * Company isn't a stage and has no ramp — it keeps its solid ink slab, which
 * is exactly the point of that column.
 */
const HEADER_INK: Partial<Record<StageLabel, string>> = {
  // Complete's pill is the one inverted pill — cream on olive. Cream on
  // `oliveSoft` would vanish, so the header takes the deep olive.
  Complete: colors.oliveDeep,
  // Pending Install's pill fg is `ocean`, which is roughly 2:1 on `skySoft`.
  // That passes as a 12pt pill sitting on white; it does not pass as a 15pt
  // column title on the tint itself, so this one header drops the hue and
  // takes ink. The gradient behind it still says which stage this is.
  'Pending Install': colors.ink,
};

function columnHeaderTone(stage: StageLabel): {
  gradient: readonly [string, string] | null;
  bg: string;
  fg: string;
} {
  if (stage === COMPANY_LABEL) {
    const tone = LABEL_COLORS[stage];
    return { gradient: null, bg: tone.bg, fg: tone.fg };
  }
  const ramp = STAGE_GRADIENT[stage];
  return {
    gradient: ramp,
    bg: ramp[0],
    fg: HEADER_INK[stage] ?? LABEL_COLORS[stage].fg,
  };
}

function BoardCard({
  job,
  next,
  money,
  artUrl,
  labor,
  model,
  isAdmin,
  onMove,
  moving,
}: {
  job: Job;
  next: NextDate | undefined;
  money: JobMoney | undefined;
  artUrl: string | undefined;
  labor: JobLaborHours | undefined;
  model: ForecastModel | null;
  isAdmin: boolean;
  onMove: (job: Job, direction: -1 | 1) => void;
  moving: boolean;
}) {
  const router = useRouter();
  const [face, setFace] = useState<CardFace>('overview');
  const stage = jobStage(job);
  const index = STAGES.indexOf(stage);
  // The overhead container. It has no pipeline stage to move between, and its
  // expenses are company costs rather than job costs — so no stage arrows and
  // no per-job money on the card.
  const company = isCompanyJob(job);
  const extra = job as unknown as {
    completed_on?: string | null;
    module_count?: number | null;
    job_type?: string | null;
    has_critter_guard?: boolean | null;
  };
  const completedOn = extra.completed_on ?? null;
  const time = next ? formatTimeLabel(next.start_time) : null;

  const modules = extra.module_count ?? null;
  const forecast = forecastJob(model, extra.job_type, modules);

  // (paid − expenses − labor) ÷ paid. Same formula as the phone card; only
  // meaningful once money has actually come in.
  const profitPct =
    money && money.paid > 0
      ? ((money.paid - money.expenses - (labor?.labor ?? 0)) / money.paid) * 100
      : null;

  const open = () => router.push({ pathname: '/job/[id]', params: { id: job.id } });

  return (
    <Card padded={false}>
      <PropertyArt seed={job.id} imageUrl={artUrl} radius={radii.md} scrim={0.8} />
      <AnimatedPressable
        onPress={open}
        haptic="tapLight"
        scaleTo={0.985}
        accessibilityRole="button"
        accessibilityLabel={job.job_number ? `${job.job_number} ${job.name}` : job.name}
        style={styles.cardBody}>
        {face === 'overview' ? (
          <>
            <View style={styles.cardTop}>
              {job.job_number ? <Chip label={job.job_number} tone="olive" /> : null}
              {next ? (
                <AppText variant="caption" color={colors.textSecondary}>
                  {formatShortDate(next.work_date)}
                  {time ? ` · ${time}` : ''}
                </AppText>
              ) : stage === 'Complete' && completedOn ? (
                <AppText variant="caption" color={colors.textSecondary}>
                  {formatShortDate(completedOn)}
                </AppText>
              ) : null}
            </View>

            <AppText variant="bodyStrong" numberOfLines={2} style={styles.cardName}>
              {job.name}
            </AppText>

            {job.address ? (
              <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
                {job.address}
              </AppText>
            ) : null}

            {job.customer?.name ? (
              <View style={styles.customerRow}>
                <CustomerAvatar customer={job.customer} size={22} />
                <AppText
                  variant="caption"
                  color={colors.textSecondary}
                  numberOfLines={1}
                  style={styles.cardCustomer}>
                  {job.customer.name}
                </AppText>
              </View>
            ) : null}

            {company ? (
              <AppText
                variant="caption"
                color={colors.textPrimary}
                numberOfLines={1}
                style={styles.numeric}>
                {money ? `Overhead ${formatCurrency(money.expenses)}` : 'Company overhead'}
              </AppText>
            ) : money ? (
              <AppText
                variant="caption"
                color={colors.textPrimary}
                numberOfLines={1}
                style={styles.numeric}>
                {`Inv ${formatCurrency(money.invoiced)} · Paid ${formatCurrency(money.paid)}`}
              </AppText>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.cardTop}>
              {job.job_number ? <Chip label={job.job_number} tone="olive" /> : null}
              <View style={styles.typeChipRow}>
                {extra.has_critter_guard ? (
                  <Pill label="Critter" bg={colors.limeSoft} fg={colors.limeDeep} />
                ) : null}
                {extra.job_type ? (
                  <Pill
                    label={extra.job_type}
                    bg={colors.violetSoft}
                    fg={colors.violetDeep}
                    style={styles.typePill}
                  />
                ) : null}
              </View>
            </View>

            {/* The phone card can drop the name on page 2 — you swiped that one
                card, so you know which it is. On a board of eight columns you
                do not, and a job with no number would otherwise be anonymous. */}
            <AppText variant="bodyStrong" numberOfLines={1} style={styles.cardName}>
              {job.name}
            </AppText>

            {/* Modules and an hours forecast describe installed work. The
                overhead container has neither, so it gets the overhead figure
                alone rather than two dashes and a prompt to set a module
                count. */}
            {company ? null : (
              <>
                <View style={styles.statRow}>
                  <View style={styles.stat}>
                    <AppText variant="section" color={colors.textMuted}>
                      Modules
                    </AppText>
                    <AppText variant="numeric" style={styles.statValue}>
                      {modules ?? '—'}
                    </AppText>
                  </View>
                  <View style={styles.stat}>
                    <AppText variant="section" color={colors.textMuted}>
                      Est. hours
                    </AppText>
                    <AppText variant="numeric" style={styles.statValue}>
                      {forecast ? formatHours(forecast.hours) : '—'}
                    </AppText>
                  </View>
                </View>

                <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
                  {forecast
                    ? forecast.low !== null && forecast.high !== null
                      ? `${formatHours(forecast.low)}–${formatHours(forecast.high)} · from ${forecast.samples} finished ${forecast.basis} jobs`
                      : `from 1 finished ${forecast.basis} job — treat as rough`
                    : modules
                      ? 'No finished jobs to forecast from yet'
                      : 'Set a module count to forecast'}
                </AppText>
              </>
            )}

            {company && money ? (
              // Overhead is a company cost, not job profit. Show what it is and
              // nothing that implies a per-job margin.
              <View style={styles.moneyRow}>
                <View style={styles.moneyCell}>
                  <AppText variant="section" color={colors.textMuted}>
                    Overhead
                  </AppText>
                  <AppText variant="bodyStrong" numberOfLines={1} style={styles.numeric}>
                    {formatCurrency(money.expenses)}
                  </AppText>
                </View>
              </View>
            ) : money ? (
              <>
                <View style={styles.moneyRow}>
                  {(
                    [
                      ['Est', money.estimate !== null ? formatCurrency(money.estimate) : '—'],
                      ['Inv', formatCurrency(money.invoiced)],
                      ['Paid', formatCurrency(money.paid)],
                    ] as [string, string][]
                  ).map(([label, value]) => (
                    <View key={label} style={styles.moneyCell}>
                      <AppText variant="section" color={colors.textMuted}>
                        {label}
                      </AppText>
                      <AppText variant="caption" numberOfLines={1} style={styles.numeric}>
                        {value}
                      </AppText>
                    </View>
                  ))}
                </View>
                {money.estimateCount > 1 ? (
                  <AppText
                    variant="caption"
                    color={colors.textMuted}
                    numberOfLines={1}
                    style={styles.italic}>
                    {`Est is the newest of ${money.estimateCount} estimates`}
                  </AppText>
                ) : null}
                <View style={styles.profitRow}>
                  <AppText variant="section" color={colors.textMuted}>
                    Profit
                  </AppText>
                  <AppText
                    variant="bodyStrong"
                    color={
                      profitPct === null
                        ? colors.textSecondary
                        : profitPct >= 0
                          ? colors.success
                          : colors.danger
                    }
                    style={styles.numeric}>
                    {profitPct !== null
                      ? `${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(1)}%`
                      : '—'}
                  </AppText>
                </View>
              </>
            ) : null}
          </>
        )}
      </AnimatedPressable>

      <View style={styles.footerRow}>
        {/* Sits outside the card-body Pressable so flipping the card never
            navigates to the job. */}
        <AnimatedPressable
          onPress={() => setFace(face === 'overview' ? 'details' : 'overview')}
          haptic="tapLight"
          scaleTo={0.94}
          accessibilityRole="button"
          accessibilityLabel={
            face === 'overview'
              ? `Show details and money for ${job.name}`
              : `Show overview for ${job.name}`
          }
          style={styles.faceButton}>
          <Ionicons name="swap-horizontal" size={13} color={colors.accentPrimary} />
          <AppText variant="caption" color={colors.accentPrimary}>
            {face === 'overview' ? 'Details' : 'Overview'}
          </AppText>
          <View style={styles.dots}>
            {(['overview', 'details'] as CardFace[]).map((f) => (
              <View key={f} style={[styles.dot, face === f && styles.dotActive]} />
            ))}
          </View>
        </AnimatedPressable>

        {isAdmin && !company ? (
          <View style={styles.moveRow}>
            {moving ? <ActivityIndicator size="small" color={colors.accentPrimary} /> : null}
            <Button
              label="‹"
              onPress={() => onMove(job, -1)}
              variant="ghost"
              size="sm"
              haptic="tapLight"
              disabled={index <= 0 || moving}
              accessibilityLabel={`Move ${job.name} back a stage`}
              style={styles.moveButton}
              textStyle={styles.moveGlyph}
            />
            <Button
              label="›"
              onPress={() => onMove(job, 1)}
              variant="ghost"
              size="sm"
              haptic="tapLight"
              disabled={index >= STAGES.length - 1 || moving}
              accessibilityLabel={`Move ${job.name} forward a stage`}
              style={styles.moveButton}
              textStyle={styles.moveGlyph}
            />
          </View>
        ) : null}
      </View>
    </Card>
  );
}

export function PipelineBoard({
  jobs,
  nextDates,
  money,
  artUrls,
  labor,
  model,
  isAdmin,
  onChanged,
}: {
  jobs: Job[];
  nextDates: Map<string, NextDate>;
  money: Map<string, JobMoney> | null;
  artUrls: Map<string, string>;
  /** Labor dollars per job, for the profit figure on the details face. */
  labor: Map<string, JobLaborHours> | null;
  /** Forecast model for estimated hours. Null until it loads, or if it can't. */
  model: ForecastModel | null;
  isAdmin: boolean;
  /** Refetch the pipeline after a card moves column. */
  onChanged: () => void;
}) {
  const [movingId, setMovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pipeline stages, then a Company column on the far right — only when a
  // container job actually exists, so the board doesn't grow an empty column
  // for companies that don't use one.
  const columns: StageLabel[] = jobs.some(isCompanyJob)
    ? [...STAGES, COMPANY_LABEL]
    : [...STAGES];

  const move = async (job: Job, direction: -1 | 1) => {
    const current = STAGES.indexOf(jobStage(job));
    const target = STAGES[current + direction];
    if (!target) return;
    setMovingId(job.id);
    setError(null);
    const result = await updateJobStage(job.id, target);
    setMovingId(null);
    if (result.ok) {
      haptics.success();
      onChanged();
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={styles.wrap}>
      {error ? (
        <AppText variant="caption" color={colors.danger} style={styles.error}>
          {error}
        </AppText>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.columns}>
        {columns.map((stage) => {
          const company = stage === COMPANY_LABEL;
          // The Company container never belongs to a pipeline column — it is
          // overhead, not work in progress.
          const columnJobs = company
            ? jobs.filter(isCompanyJob)
            : jobs.filter((job) => !isCompanyJob(job) && jobStage(job) === stage);
          // Pipeline columns total what's been invoiced; the Company column
          // totals overhead spent, which is the only number that means anything
          // there.
          const value = money
            ? columnJobs.reduce(
                (sum, job) =>
                  sum +
                  (company
                    ? (money.get(job.id)?.expenses ?? 0)
                    : (money.get(job.id)?.invoiced ?? 0)),
                0,
              )
            : 0;
          const tone = columnHeaderTone(stage);
          const header = (
            <>
              <View style={styles.columnTitleRow}>
                <AppText
                  variant="bodyStrong"
                  color={tone.fg}
                  numberOfLines={1}
                  style={styles.columnTitle}>
                  {stage}
                </AppText>
                <View style={styles.countPill}>
                  <AppText variant="caption" color={tone.fg}>
                    {columnJobs.length}
                  </AppText>
                </View>
              </View>
              {money && value > 0 ? (
                <AppText variant="caption" color={tone.fg} style={styles.columnValue}>
                  {formatCurrency(value)}
                </AppText>
              ) : null}
            </>
          );
          return (
            <View key={stage} style={styles.column}>
              {tone.gradient ? (
                <LinearGradient
                  colors={tone.gradient}
                  // Diagonal, with the saturated stop pinned to the far corner:
                  // the copy lives top-left, on the soft end.
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                  locations={[0.45, 1]}
                  style={styles.columnHeader}>
                  {header}
                </LinearGradient>
              ) : (
                <View style={[styles.columnHeader, { backgroundColor: tone.bg }]}>{header}</View>
              )}

              <ScrollView
                style={styles.columnScroll}
                contentContainerStyle={styles.columnBody}
                showsVerticalScrollIndicator={false}>
                {columnJobs.length === 0 ? (
                  <AppText variant="caption" color={colors.textMuted} style={styles.emptyColumn}>
                    Nothing here
                  </AppText>
                ) : (
                  columnJobs.map((job) => (
                    <BoardCard
                      key={job.id}
                      job={job}
                      next={nextDates.get(job.id)}
                      money={money?.get(job.id)}
                      artUrl={artUrls.get(job.id)}
                      labor={labor?.get(job.id)}
                      model={model}
                      isAdmin={isAdmin}
                      onMove={move}
                      moving={movingId === job.id}
                    />
                  ))
                )}
              </ScrollView>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
  },
  error: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },
  columns: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
  },
  column: {
    width: COLUMN_WIDTH,
    backgroundColor: 'rgba(255,255,255,0.55)',
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  columnHeader: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    gap: 2,
  },
  columnTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  columnTitle: {
    flexShrink: 1,
  },
  countPill: {
    backgroundColor: 'rgba(255,255,255,0.65)',
    borderRadius: radii.pill,
    minWidth: 24,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: 1,
    alignItems: 'center',
  },
  columnValue: {
    fontVariant: ['tabular-nums'],
    opacity: 0.9,
  },
  columnScroll: {
    maxHeight: 640,
  },
  columnBody: {
    padding: spacing.sm,
    gap: spacing.sm,
  },
  emptyColumn: {
    fontStyle: 'italic',
    padding: spacing.sm,
  },
  cardBody: {
    padding: spacing.sm + 2,
    gap: spacing.xs,
    minHeight: 96,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  cardName: {
    fontSize: 13,
    lineHeight: 17,
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  cardCustomer: {
    flexShrink: 1,
  },
  numeric: {
    fontVariant: ['tabular-nums'],
  },
  italic: {
    fontStyle: 'italic',
  },
  // ---- details face ----
  typeChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  typePill: {
    flexShrink: 1,
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  stat: {
    flex: 1,
  },
  statValue: {
    fontSize: 15,
    lineHeight: 20,
  },
  moneyRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  moneyCell: {
    flex: 1,
  },
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },

  // ---- footer: face toggle + stage arrows ----
  footerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
  },
  faceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.75)',
    paddingHorizontal: spacing.sm,
    height: 24,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    marginLeft: 2,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
  },
  dotActive: {
    backgroundColor: colors.accentPrimary,
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  moveButton: {
    width: 30,
    minHeight: 24,
    height: 24,
    paddingVertical: 0,
    paddingHorizontal: 0,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: 'rgba(255,255,255,0.75)',
  },
  moveGlyph: {
    fontSize: 18,
    lineHeight: 20,
  },
});
