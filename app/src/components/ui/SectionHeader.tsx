import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, spacing } from '@/constants/theme';
import { AppText } from './AppText';
import { AnimatedPressable } from './AnimatedPressable';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * The small uppercase eyebrow that introduces a group of rows or cards,
 * optionally with an icon and one text action on the right ("See all",
 * "Add", "Manage").
 *
 * Deliberately quiet: `typography.section` is 12pt olive-on-cream, so it
 * organises the page without competing with the content it labels.
 *
 * `accent` (2026-09-12 overhaul) recolours the eyebrow and adds a short
 * colour bar on its left — the Home and Menu sections carry their hub's hue
 * (`hubColors[key].fg`) so a block of rows reads as belonging to that hub.
 */
export function SectionHeader({
  title,
  subtitle,
  icon,
  action,
  accent,
  style,
}: {
  title: string;
  /** One line of context under the title. Keep it short. */
  subtitle?: string;
  icon?: IconName;
  /** A single text affordance on the right of the row. */
  action?: { label: string; onPress: () => void; icon?: IconName };
  /** Eyebrow colour plus a small bar on the left, e.g. a hub colour. */
  accent?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const tint = accent ?? colors.accentPrimary;
  return (
    <View style={[styles.wrap, style]}>
      <View style={styles.left}>
        {accent ? <View style={[styles.bar, { backgroundColor: accent }]} /> : null}
        {icon ? (
          <Ionicons name={icon} size={15} color={tint} style={styles.icon} />
        ) : null}
        <View style={styles.titles}>
          <AppText variant="section" color={tint}>
            {title}
          </AppText>
          {subtitle ? (
            <AppText variant="caption" color={colors.textMuted}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
      </View>

      {action ? (
        <AnimatedPressable
          onPress={action.onPress}
          haptic="tapLight"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={action.label}
          style={styles.action}>
          <AppText variant="caption" color={colors.accentLink}>
            {action.label}
          </AppText>
          {action.icon ? (
            <Ionicons name={action.icon} size={14} color={colors.accentLink} />
          ) : null}
        </AnimatedPressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  left: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    flexShrink: 1,
  },
  icon: {
    // Optical alignment with the cap height of an uppercase eyebrow.
    marginTop: -1,
  },
  /** The hub colour bar: short, rounded, sits on the eyebrow's baseline. */
  bar: {
    width: 4,
    height: 14,
    borderRadius: 2,
    marginRight: 2,
  },
  titles: {
    flexShrink: 1,
    gap: 1,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
});
