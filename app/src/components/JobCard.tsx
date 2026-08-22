import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { StatusPill } from '@/components/StatusPill';
import { AnimatedPressable, AppText, Card, Chip } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { type Job } from '@/lib/types';
import { labelForJob } from '@/lib/stages';

/**
 * The job summary card used by Home and the Calendar.
 *
 * 2026-08-22 restyle: the hand-rolled card/chip/pressed styles are gone —
 * `Card` owns the surface, `Chip` the job number, `StatusPill` the stage and
 * `AnimatedPressable` the press. Nothing about what it shows changed.
 */
export function JobCard({ job, subtitle }: { job: Job; subtitle?: string }) {
  const router = useRouter();
  return (
    <AnimatedPressable
      onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
      haptic="tapLight"
      accessibilityRole="button"
      accessibilityLabel={job.job_number ? `${job.job_number} ${job.name}` : job.name}>
      <Card style={styles.card}>
        <View style={styles.topRow}>
          {job.job_number ? <Chip label={job.job_number} tone="olive" /> : null}
          <StatusPill stage={labelForJob(job)} />
        </View>
        {subtitle ? (
          <AppText variant="caption" color={colors.accentPrimary}>
            {subtitle}
          </AppText>
        ) : null}
        <AppText variant="heading">{job.name}</AppText>
        {job.address ? (
          <AppText variant="body" color={colors.textSecondary}>
            {job.address}
          </AppText>
        ) : null}
      </Card>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.xs,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
  },
});
