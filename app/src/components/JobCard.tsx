import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { StatusPill } from '@/components/StatusPill';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { type Job } from '@/lib/mockData';
import { labelForJob } from '@/lib/stages';

export function JobCard({ job, subtitle }: { job: Job; subtitle?: string }) {
  const router = useRouter();
  return (
    <Pressable
      onPress={() => router.push({ pathname: '/job/[id]', params: { id: job.id } })}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
      <View style={styles.topRow}>
        {job.job_number ? (
          <View style={styles.chip}>
            <Text style={styles.chipText}>{job.job_number}</Text>
          </View>
        ) : null}
        <StatusPill stage={labelForJob(job)} />
      </View>
      {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      <Text style={styles.name}>{job.name}</Text>
      {job.address ? <Text style={styles.address}>{job.address}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  pressed: {
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
  subtitle: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '700',
  },
  name: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '700',
  },
  address: {
    color: colors.inkSoft,
    fontSize: 14,
  },
});
