import Ionicons from '@expo/vector-icons/Ionicons';
import { router, type Href } from 'expo-router';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { accentCycle, colors, radii, shadows, spacing } from '@/constants/theme';
import { AnimatedPressable } from './AnimatedPressable';
import { AppText } from './AppText';

type IconName = keyof typeof Ionicons.glyphMap;

/**
 * A tile's color: an index into `accentCycle` (so a grid of them walks the
 * ramp and no two neighbours match), or 'olive' for the brand-lead tile.
 */
export type TileTone = number | 'olive';

/**
 * The square-ish destination tile the Home hub is built from.
 *
 * Navigation is `href` + `router.push` rather than wrapping a `Link`, because
 * the whole tile is an `AnimatedPressable` and `Link asChild` fights the
 * press animation for the ref. `href` is typed against expo-router's typed
 * routes (`app.json` sets `experiments.typedRoutes`), so a tile pointing at a
 * route that doesn't exist is a compile error rather than a dead tap.
 *
 * Pass `onPress` INSTEAD of `href` for a tile that does something local.
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
      accessibilityLabel={badge ? `${title}, ${badge} new` : title}
      style={[styles.tile, disabled && styles.disabled, style]}>
      <View style={[styles.iconWrap, { backgroundColor: palette.bg }]}>
        <Ionicons name={icon} size={20} color={palette.fg} />
        {badge && badge > 0 ? (
          <View style={styles.badge}>
            <AppText variant="caption" color={colors.white} style={styles.badgeText}>
              {badge > 99 ? '99+' : String(badge)}
            </AppText>
          </View>
        ) : null}
      </View>

      <View style={styles.text}>
        <AppText variant="bodyStrong" numberOfLines={2}>
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

function paletteFor(tone: TileTone): { bg: string; fg: string } {
  if (tone === 'olive') return { bg: colors.oliveSoft, fg: colors.oliveDeep };
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
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
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
  disabled: {
    opacity: 0.45,
  },
});
