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
 */
export function SectionHeader({
  title,
  subtitle,
  icon,
  action,
  style,
}: {
  title: string;
  /** One line of context under the title. Keep it short. */
  subtitle?: string;
  icon?: IconName;
  /** A single text affordance on the right of the row. */
  action?: { label: string; onPress: () => void; icon?: IconName };
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.wrap, style]}>
      <View style={styles.left}>
        {icon ? (
          <Ionicons name={icon} size={15} color={colors.accentPrimary} style={styles.icon} />
        ) : null}
        <View style={styles.titles}>
          <AppText variant="section" color={colors.accentPrimary}>
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
