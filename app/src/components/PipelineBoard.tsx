import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PropertyArt } from '@/components/PropertyArt';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { forecastJob, type ForecastModel } from '@/lib/forecast';
import { updateJobStage } from '@/lib/jobs';
import { type Job } from '@/lib/mockData';
import { type JobLaborHours, type JobMoney, type NextDate } from '@/lib/pipeline';
import { STAGES, STAGE_COLORS, stageOrDefault, type Stage } from '@/lib/stages';
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
    <View style={styles.card}>
      <PropertyArt seed={job.id} imageUrl={artUrl} radius={radii.md} scrim={0.8} />
      <Pressable
        onPress={open}
        style={({ pressed }) => [styles.cardBody, pressed && styles.cardPressed]}>
        {face === 'overview' ? (
          <>
            <View style={styles.cardTop}>
              {job.job_number ? (
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{job.job_number}</Text>
                </View>
              ) : null}
              {next ? (
                <Text style={styles.cardDate}>
                  {formatShortDate(next.work_date)}
                  {time ? ` · ${time}` : ''}
                </Text>
              ) : stage === 'Complete' && completedOn ? (
                <Text style={styles.cardDate}>{formatShortDate(completedOn)}</Text>
              ) : null}
            </View>

            <Text style={styles.cardName} numberOfLines={2}>
              {job.name}
            </Text>

            {job.address ? (
              <Text style={styles.cardAddress} numberOfLines={1}>
                {job.address}
              </Text>
            ) : null}

            {job.customer?.name ? (
              <View style={styles.customerRow}>
                <CustomerAvatar customer={job.customer} size={22} />
                <Text style={styles.cardCustomer} numberOfLines={1}>
                  {job.customer.name}
                </Text>
              </View>
            ) : null}

            {money ? (
              <Text style={styles.cardMoney} numberOfLines={1}>
                {`Inv ${formatCurrency(money.invoiced)} · Paid ${formatCurrency(money.paid)}`}
              </Text>
            ) : null}
          </>
        ) : (
          <>
            <View style={styles.cardTop}>
              {job.job_number ? (
                <View style={styles.chip}>
                  <Text style={styles.chipText}>{job.job_number}</Text>
                </View>
              ) : null}
              <View style={styles.typeChipRow}>
                {extra.has_critter_guard ? (
                  <View style={styles.critterChip}>
                    <Text style={styles.critterChipText}>Critter</Text>
                  </View>
                ) : null}
                {extra.job_type ? (
                  <View style={styles.typeChip}>
                    <Text style={styles.typeChipText} numberOfLines={1}>
                      {extra.job_type}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>

            {/* The phone card can drop the name on page 2 — you swiped that one
                card, so you know which it is. On a board of eight columns you
                do not, and a job with no number would otherwise be anonymous. */}
            <Text style={styles.cardName} numberOfLines={1}>
              {job.name}
            </Text>

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

            <Text style={styles.forecastNote} numberOfLines={2}>
              {forecast
                ? forecast.low !== null && forecast.high !== null
                  ? `${formatHours(forecast.low)}–${formatHours(forecast.high)} · from ${forecast.samples} finished ${forecast.basis} jobs`
                  : `from 1 finished ${forecast.basis} job — treat as rough`
                : modules
                  ? 'No finished jobs to forecast from yet'
                  : 'Set a module count to forecast'}
            </Text>

            {money ? (
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
                      <Text style={styles.statLabel}>{label}</Text>
                      <Text style={styles.moneyValue} numberOfLines={1}>
                        {value}
                      </Text>
                    </View>
                  ))}
                </View>
                {money.estimateCount > 1 ? (
                  <Text style={styles.estimateNote} numberOfLines={1}>
                    {`Est is the newest of ${money.estimateCount} estimates`}
                  </Text>
                ) : null}
                <View style={styles.profitRow}>
                  <Text style={styles.statLabel}>Profit</Text>
                  <Text
                    style={[
                      styles.profitValue,
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
          </>
        )}
      </Pressable>

      <View style={styles.footerRow}>
        {/* Sits outside the card-body Pressable so flipping the card never
            navigates to the job. */}
        <Pressable
          onPress={() => setFace(face === 'overview' ? 'details' : 'overview')}
          accessibilityRole="button"
          accessibilityLabel={
            face === 'overview'
              ? `Show details and money for ${job.name}`
              : `Show overview for ${job.name}`
          }
          style={({ pressed }) => [styles.faceButton, pressed && styles.faceButtonPressed]}>
          <Ionicons name="swap-horizontal" size={13} color={colors.inkSoft} />
          <Text style={styles.faceButtonText}>
            {face === 'overview' ? 'Details' : 'Overview'}
          </Text>
          <View style={styles.dots}>
            {(['overview', 'details'] as CardFace[]).map((f) => (
              <View key={f} style={[styles.dot, face === f && styles.dotActive]} />
            ))}
          </View>
        </Pressable>

        {isAdmin ? (
          <View style={styles.moveRow}>
            {moving ? <ActivityIndicator size="small" color={colors.ocean} /> : null}
            <Pressable
              onPress={() => onMove(job, -1)}
              disabled={index <= 0 || moving}
              accessibilityRole="button"
              accessibilityLabel={`Move ${job.name} back a stage`}
              style={({ pressed }) => [
                styles.moveButton,
                (index <= 0 || moving) && styles.moveDisabled,
                pressed && index > 0 && !moving && styles.moveHover,
              ]}>
              <Ionicons name="chevron-back" size={14} color={colors.inkSoft} />
            </Pressable>
            <Pressable
              onPress={() => onMove(job, 1)}
              disabled={index >= STAGES.length - 1 || moving}
              accessibilityRole="button"
              accessibilityLabel={`Move ${job.name} forward a stage`}
              style={({ pressed }) => [
                styles.moveButton,
                (index >= STAGES.length - 1 || moving) && styles.moveDisabled,
                pressed && index < STAGES.length - 1 && !moving && styles.moveHover,
              ]}>
              <Ionicons name="chevron-forward" size={14} color={colors.inkSoft} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
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

  const move = async (job: Job, direction: -1 | 1) => {
    const current = STAGES.indexOf(jobStage(job));
    const target = STAGES[current + direction];
    if (!target) return;
    setMovingId(job.id);
    setError(null);
    const result = await updateJobStage(job.id, target);
    setMovingId(null);
    if (result.ok) onChanged();
    else setError(result.message);
  };

  return (
    <View style={styles.wrap}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.columns}>
        {STAGES.map((stage) => {
          const columnJobs = jobs.filter((job) => jobStage(job) === stage);
          const value = money
            ? columnJobs.reduce((sum, job) => sum + (money.get(job.id)?.invoiced ?? 0), 0)
            : 0;
          const tone = STAGE_COLORS[stage];
          return (
            <View key={stage} style={styles.column}>
              <View style={[styles.columnHeader, { backgroundColor: tone.bg }]}>
                <View style={styles.columnTitleRow}>
                  <Text style={[styles.columnTitle, { color: tone.fg }]} numberOfLines={1}>
                    {stage}
                  </Text>
                  <View style={styles.countPill}>
                    <Text style={[styles.countPillText, { color: tone.fg }]}>
                      {columnJobs.length}
                    </Text>
                  </View>
                </View>
                {money && value > 0 ? (
                  <Text style={[styles.columnValue, { color: tone.fg }]}>
                    {formatCurrency(value)}
                  </Text>
                ) : null}
              </View>

              <ScrollView
                style={styles.columnScroll}
                contentContainerStyle={styles.columnBody}
                showsVerticalScrollIndicator={false}>
                {columnJobs.length === 0 ? (
                  <Text style={styles.emptyColumn}>Nothing here</Text>
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
    color: colors.danger,
    fontSize: 13,
    fontWeight: '700',
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
    borderColor: colors.line,
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
    fontSize: 14,
    fontWeight: '800',
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
  countPillText: {
    fontSize: 12,
    fontWeight: '800',
  },
  columnValue: {
    fontSize: 12,
    fontWeight: '700',
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
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    fontStyle: 'italic',
    padding: spacing.sm,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  cardBody: {
    padding: spacing.sm + 2,
    gap: spacing.xs,
    minHeight: 96,
  },
  cardPressed: {
    opacity: 0.85,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
  },
  chip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  chipText: {
    color: colors.ocean,
    fontSize: 11,
    fontWeight: '800',
  },
  cardDate: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
  },
  cardAddress: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '600',
  },
  cardName: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 17,
  },
  customerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  cardCustomer: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  cardMoney: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  // ---- details face ----
  typeChipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexShrink: 1,
  },
  typeChip: {
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
    flexShrink: 1,
  },
  typeChipText: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
  },
  critterChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  critterChipText: {
    color: colors.ocean,
    fontSize: 10,
    fontWeight: '800',
  },
  statRow: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  stat: {
    flex: 1,
  },
  statLabel: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  statValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  forecastNote: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '600',
    lineHeight: 13,
  },
  moneyRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  moneyCell: {
    flex: 1,
  },
  moneyValue: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  estimateNote: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  profitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xs,
  },
  profitValue: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  profitPositive: {
    color: colors.ocean,
  },
  profitNegative: {
    color: colors.danger,
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
    borderColor: colors.line,
    backgroundColor: 'rgba(255,255,255,0.75)',
    paddingHorizontal: spacing.sm,
    height: 24,
  },
  faceButtonPressed: {
    backgroundColor: colors.skySoft,
    borderColor: colors.ocean,
  },
  faceButtonText: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
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
    backgroundColor: colors.line,
  },
  dotActive: {
    backgroundColor: colors.ocean,
  },
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  moveButton: {
    width: 30,
    height: 24,
    borderRadius: radii.sm,
    backgroundColor: 'rgba(255,255,255,0.75)',
    borderWidth: 1,
    borderColor: colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  moveHover: {
    backgroundColor: colors.skySoft,
    borderColor: colors.ocean,
  },
  moveDisabled: {
    opacity: 0.3,
  },
});
