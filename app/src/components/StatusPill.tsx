import { StyleSheet, Text, View } from 'react-native';

import { radii, spacing } from '@/constants/theme';
import { STAGE_COLORS, stageOrDefault, type Stage } from '@/lib/stages';

/**
 * Pill showing a project's pipeline stage. Pass `stage` when known; legacy
 * callers that only have the jobs.status value can keep passing `status`,
 * which maps via stageOrDefault ('completed' → Complete, everything else →
 * Pending Estimate) so the whole app speaks the stage vocabulary.
 */
export function StatusPill({
  stage,
  status,
}: {
  stage?: Stage | null;
  status?: string | null;
}) {
  const resolved = stage ?? stageOrDefault(undefined, status);
  const c = STAGE_COLORS[resolved];
  return (
    <View style={[styles.pill, { backgroundColor: c.bg }]}>
      <Text style={[styles.text, { color: c.fg }]}>{resolved}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 12,
    fontWeight: '700',
  },
});
