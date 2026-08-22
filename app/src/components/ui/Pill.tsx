import { StyleSheet, View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';

import { radii, spacing } from '@/constants/theme';
import { AppText } from './AppText';

/**
 * A read-only label pill in explicit colors.
 *
 * Deliberately dumb — it takes `bg` and `fg` rather than a tone name, because
 * its callers already own a color map: `STAGE_COLORS`/`LABEL_COLORS` for
 * stages, `ROLE_META` for employee roles, the per-screen `STATUS_STYLES` maps
 * in time-off and receipts. Those maps decide meaning; this decides shape.
 *
 * For something a person can TAP, use `Chip` instead.
 */
export function Pill({
  label,
  bg,
  fg,
  style,
  textStyle,
}: {
  label: string;
  /** Background. */
  bg: string;
  /** Text color. Must clear 4.5:1 on `bg` — see the olive rules in theme.ts. */
  fg: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
}) {
  return (
    <View style={[styles.pill, { backgroundColor: bg }, style]}>
      <AppText variant="caption" color={fg} numberOfLines={1} style={textStyle}>
        {label}
      </AppText>
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
});
