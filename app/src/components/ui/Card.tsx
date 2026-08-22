import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';

export type CardTone = 'plain' | 'sunk' | 'danger' | 'olive';
export type CardElevation = 'none' | 'subtle' | 'card' | 'raised' | 'hero';

/**
 * The card recipe, once.
 *
 * `{backgroundColor: white, borderRadius: radii.md, padding: spacing.md,
 * ...shadows.card}` was copy-pasted into about thirty screens' local
 * StyleSheets. Every one of them had to be found and edited by hand for the
 * olive palette; that is what this component exists to stop.
 *
 * Tones:
 *   plain  — white, sitting ON the cream page. The default.
 *   sunk   — a well punched INTO the page: no shadow, a border, warmer fill.
 *            Use for nested content (a form inside a card, an inset list).
 *   danger — the tinted ground for a destructive confirmation.
 *   olive  — inverted. Text on it must be `textOnDark`; `AppText` will not
 *            do that for you, so pass `color={colors.textOnDark}`.
 */
export function Card({
  tone = 'plain',
  elevation,
  padded = true,
  clip = true,
  style,
  children,
  ...rest
}: {
  tone?: CardTone;
  /** Defaults to `card` for plain/danger/olive and `none` for sunk. */
  elevation?: CardElevation;
  /** `false` when the card's children handle their own insets (lists, images). */
  padded?: boolean;
  /**
   * Clip children to the rounded corner. On by default so a full-bleed
   * gradient, photo or divider can't square off a corner — this is what
   * every hand-rolled card in the app already did. Turn it OFF only when
   * something must escape the card (an overlapping avatar, a dropdown), and
   * be aware that iOS clips the drop shadow while it's on.
   */
  clip?: boolean;
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
} & Omit<React.ComponentProps<typeof View>, 'style' | 'children'>) {
  const level = elevation ?? (tone === 'sunk' ? 'none' : 'card');
  return (
    <View
      {...rest}
      style={[
        styles.base,
        clip && styles.clip,
        TONES[tone],
        level === 'none' ? null : shadows[level],
        padded && styles.padded,
        style,
      ]}>
      {children}
    </View>
  );
}

const TONES: Record<CardTone, ViewStyle> = {
  plain: { backgroundColor: colors.surface },
  sunk: {
    backgroundColor: colors.surfaceSunk,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
  },
  danger: { backgroundColor: colors.dangerSoft },
  olive: { backgroundColor: colors.accentPrimary },
};

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
  },
  clip: {
    overflow: 'hidden',
  },
  padded: {
    padding: spacing.md,
  },
});
