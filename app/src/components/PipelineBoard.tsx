import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PropertyArt } from '@/components/PropertyArt';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate } from '@/lib/dates';
import { updateJobStage } from '@/lib/jobs';
import { type Job } from '@/lib/mockData';
import { type JobMoney, type NextDate } from '@/lib/pipeline';
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
 */

const COLUMN_WIDTH = 284;

function formatCurrency(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function jobStage(job: Job): Stage {
  return stageOrDefault((job as unknown as { stage?: unknown }).stage, job.status);
}

function BoardCard({
  job,
  next,
  money,
  artUrl,
  isAdmin,
  onMove,
  moving,
}: {
  job: Job;
  next: NextDate | undefined;
  money: JobMoney | undefined;
  artUrl: string | undefined;
  isAdmin: boolean;
  onMove: (job: Job, direction: -1 | 1) => void;
  moving: boolean;
}) {
  const router = useRouter();
  const stage = jobStage(job);
  const index = STAGES.indexOf(stage);
  const completedOn = (job as unknown as { completed_on?: string | null }).completed_on ?? null;
  const time = next ? formatTimeLabel(next.start_time) : null;

  return (
    <View style={styles.card}>
      <PropertyArt seed={job.id} imageUrl={artUrl} radius={radii.md} scrim={0.8} />
      <Pressable
        onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
        style={({ pressed }) => [styles.cardBody, pressed && styles.cardPressed]}>
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
      </Pressable>

      {isAdmin ? (
        <View style={styles.moveRow}>
          <Pressable
            onPress={() => onMove(job, -1)}
            disabled={index <= 0 || moving}
            style={({ pressed }) => [
              styles.moveButton,
              (index <= 0 || moving) && styles.moveDisabled,
              pressed && index > 0 && !moving && styles.moveHover,
            ]}>
            <Ionicons name="chevron-back" size={14} color={colors.inkSoft} />
          </Pressable>
          {moving ? <ActivityIndicator size="small" color={colors.ocean} /> : null}
          <Pressable
            onPress={() => onMove(job, 1)}
            disabled={index >= STAGES.length - 1 || moving}
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
  );
}

export function PipelineBoard({
  jobs,
  nextDates,
  money,
  artUrls,
  isAdmin,
  onChanged,
}: {
  jobs: Job[];
  nextDates: Map<string, NextDate>;
  money: Map<string, JobMoney> | null;
  artUrls: Map<string, string>;
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
  moveRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.sm,
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
