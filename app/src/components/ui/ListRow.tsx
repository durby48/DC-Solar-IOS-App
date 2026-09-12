import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { AnimatedPressable } from './AnimatedPressable';
import { AppText } from './AppText';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * A row in a grouped list: tinted icon square, title, optional subtitle, and
 * whatever belongs on the right.
 *
 * This is the Menu/settings row the app already draws by hand in nine
 * screens. Drop rows into a `<Card padded={false}>` and set `divider` on all
 * but the last for the grouped look.
 *
 * `danger` recolours the icon and title for destructive rows (Sign out,
 * Delete) so they never look like just another entry.
 *
 * `locked` (2026-09-12 overhaul) draws the row as an admin-only door: a lock
 * glyph where the chevron would be, muted title and icon — but it stays
 * PRESSABLE, because the press is where the "contact your administrator"
 * explanation lives (`lib/adminGate.ts`). Every role sees the same rows.
 */
export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  iconBackground,
  right,
  onPress,
  badge,
  danger = false,
  divider = false,
  disabled = false,
  locked = false,
  chevron,
  style,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  /** Overrides the default olive/danger icon color. */
  iconColor?: string;
  /** Overrides the default tinted icon square. */
  iconBackground?: string;
  /** Anything on the right: a `Pill`, a `Switch`, a value. */
  right?: ReactNode;
  onPress?: () => void;
  /** Live count. 0 hides it. */
  badge?: number;
  danger?: boolean;
  /** Hairline under the row. Set on every row but the last of a group. */
  divider?: boolean;
  disabled?: boolean;
  /** Admin-only for this person: lock glyph, muted, still pressable. */
  locked?: boolean;
  /** Defaults to true when the row navigates. */
  chevron?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const tint = locked
    ? colors.textMuted
    : (iconColor ?? (danger ? colors.danger : colors.accentPrimary));
  const square = locked
    ? colors.surfaceSunk
    : (iconBackground ?? (danger ? colors.dangerSoft : colors.oliveSoft));
  const showChevron = !locked && (chevron ?? Boolean(onPress));

  const body = (
    <>
      {icon ? (
        <View style={[styles.iconWrap, { backgroundColor: square }]}>
          <Ionicons name={icon} size={18} color={tint} />
        </View>
      ) : null}

      <View style={styles.text}>
        <AppText
          variant="bodyStrong"
          color={danger ? colors.danger : locked ? colors.textSecondary : colors.textPrimary}
          numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
            {subtitle}
          </AppText>
        ) : null}
      </View>

      {badge && badge > 0 ? (
        <View style={styles.badge}>
          <AppText variant="caption" color={colors.white} style={styles.badgeText}>
            {badge > 99 ? '99+' : String(badge)}
          </AppText>
        </View>
      ) : null}

      {right}

      {locked ? (
        <View style={styles.lock}>
          <Ionicons name="lock-closed" size={12} color={colors.textMuted} />
        </View>
      ) : null}

      {showChevron ? (
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      ) : null}
    </>
  );

  const shape: StyleProp<ViewStyle> = [
    styles.row,
    divider && styles.divider,
    disabled && styles.disabled,
    style,
  ];

  if (!onPress) return <View style={shape}>{body}</View>;

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      haptic="tapLight"
      // A full-width row barely reads as scaling; keep it subtle.
      scaleTo={0.985}
      accessibilityRole="button"
      accessibilityLabel={
        locked ? `${title}, admin only` : badge ? `${title}, ${badge} new` : title
      }
      style={shape}>
      {body}
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    backgroundColor: colors.surface,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: 1,
  },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radii.pill,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 11,
    lineHeight: 14,
  },
  lock: {
    width: 22,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceSunk,
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: {
    opacity: 0.45,
  },
});
