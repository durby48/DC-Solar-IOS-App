import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { accentCycle, colors, hubColors, radii, shadows, spacing, type HubKey } from '@/constants/theme';
import { AnimatedPressable } from './AnimatedPressable';
import { AppText } from './AppText';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * A tile's color: an index into `accentCycle` (so a grid of them walks the
 * ramp and no two neighbours match), 'olive' for the brand-lead tile, or a
 * hub key (2026-09-12) for a tile that belongs to one of the five Home hubs.
 */
export type TileTone = number | 'olive' | HubKey;

/**
 * The square-ish destination tile the Home hub is built from.
 *
 * 2026-09-12 overhaul: every tile carries a COLOUR EDGE — a hairline around
 * the white surface in the same hue as its icon — so a grid reads as sharp
 * blocks of colour on the white page instead of identical white cards.
 * `compact` (the desktop browser) shrinks the icon square and padding: at
 * four columns the phone-sized whitespace behind each icon looked empty.
 *
 * `locked` draws the tile as an admin-only door (lock badge, muted) but keeps
 * it PRESSABLE — the press handler is where the "contact your administrator"
 * alert lives, so every role sees the same layout and a crew member learns
 * what is behind the door instead of never knowing it exists.
 *
 * Navigation is `href` + `router.push` rather than wrapping a `Link`, because
 * the whole tile is an `AnimatedPressable` and `Link asChild` fights the
 * press animation for the ref. Pass `onPress` INSTEAD of `href` for a tile
 * that does something local.
 */
export function Tile({
  title,
  icon,
  href,
  onPress,
  tone = 0,
  subtitle,
  badge,
  disabled = false,
  compact = false,
  locked = false,
  style,
}: {
  title: string;
  icon: IconName;
  /** Where it goes. Omit and pass `onPress` for a non-navigating tile. */
  href?: Href;
  onPress?: () => void;
  tone?: TileTone;
  /** One short line under the title. */
  subtitle?: string;
  /** A live count — unread texts, pending approvals. 0 hides it. */
  badge?: number;
  disabled?: boolean;
  /** Smaller icon square and padding — the desktop grid. */
  compact?: boolean;
  /** Admin-only for this person: shown, but the press is expected to explain. */
  locked?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = paletteFor(tone);

  const handlePress = () => {
    if (onPress) {
      onPress();
      return;
    }
    if (href) router.push(href);
  };

  return (
    <AnimatedPressable
      onPress={handlePress}
      disabled={disabled}
      haptic="tapLight"
      accessibilityRole="button"
      accessibilityLabel={locked ? `${title}, admin only` : badge ? `${title}, ${badge} new` : title}
      style={[
        styles.tile,
        compact && styles.tileCompact,
        { borderColor: locked ? colors.borderStrong : palette.fg },
        disabled && styles.disabled,
        style,
      ]}>
      <View
        style={[
          styles.iconWrap,
          compact && styles.iconWrapCompact,
          { backgroundColor: locked ? colors.surfaceSunk : palette.bg },
        ]}>
        <Ionicons name={icon} size={compact ? 18 : 20} color={locked ? colors.textMuted : palette.fg} />
        {badge && badge > 0 ? (
          <View style={styles.badge}>
            <AppText variant="caption" color={colors.white} style={styles.badgeText}>
              {badge > 99 ? '99+' : String(badge)}
            </AppText>
          </View>
        ) : null}
        {locked ? (
          <View style={styles.lock}>
            <Ionicons name="lock-closed" size={9} color={colors.white} />
          </View>
        ) : null}
      </View>

      <View style={styles.text}>
        <AppText variant="bodyStrong" numberOfLines={2} color={locked ? colors.textSecondary : undefined}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
    </AnimatedPressable>
  );
}

export function paletteFor(tone: TileTone): { bg: string; fg: string } {
  if (tone === 'olive') return { bg: colors.oliveSoft, fg: colors.oliveDeep };
  if (typeof tone === 'string') {
    const hub = hubColors[tone];
    return { bg: hub.bg, fg: hub.fg };
  }
  const entry = accentCycle[Math.abs(Math.floor(tone)) % accentCycle.length];
  return { bg: entry.bg, fg: entry.fg };
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    // Grids give tiles a width; a lone tile shouldn't stretch to the page.
    minWidth: 140,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1.5,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.subtle,
  },
  tileCompact: {
    minWidth: 120,
    padding: spacing.sm + 2,
    gap: spacing.xs + 2,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapCompact: {
    width: 30,
    height: 30,
    borderRadius: 8,
  },
  text: {
    gap: 2,
  },
  badge: {
    position: 'absolute',
    top: -5,
    right: -5,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: radii.pill,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },
  badgeText: {
    fontSize: 10,
    lineHeight: 13,
  },
  lock: {
    position: 'absolute',
    bottom: -4,
    right: -4,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.slate,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.surface,
  },
  disabled: {
    opacity: 0.45,
  },
});
