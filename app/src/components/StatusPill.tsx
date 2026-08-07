import { StyleSheet, Text, View } from 'react-native';

import { radii, spacing } from '@/constants/theme';
import {
  LABEL_COLORS,
  stageOrDefault,
  type Stage,
  type StageLabel,
} from '@/lib/stages';

/**
 * Pill showing a project's pipeline stage. Pass `stage` when known; legacy
 * callers that only have the jobs.status value can keep passing `status`,
 * which maps via stageOrDefault ('completed' → Complete, everything else →
 * Pending Estimate) so the whole app speaks the stage vocabulary.
 *
 * `stage` also accepts the Company label for the overhead container job — use
 * `labelForJob()` to resolve it, which prefers Company over the stored stage.
 */
export function StatusPill({
  stage,
  status,
}: {
  stage?: StageLabel | Stage | null;
  status?: string | null;
}) {
  const resolved = stage ?? stageOrDefault(undefined, status);
  const c = LABEL_COLORS[resolved];
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
