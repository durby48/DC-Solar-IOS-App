import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { gradients, radii, type GradientKey } from '@/constants/theme';

type Point = { x: number; y: number };

/**
 * A gradient-filled box. Thin wrapper over `expo-linear-gradient` whose whole
 * job is to stop stop-lists being retyped into screens: pass a key from
 * `gradients` in the theme and the palette stays in one file.
 *
 * Defaults to a vertical (top → bottom) sweep, which is what every header,
 * scrim and card fill in this app wants.
 *
 * Read the contrast note on `gradients` before putting text on one:
 * olive / oliveSky / ink take cream text, sunrise / cream take ink text.
 */
export function GradientSurface({
  gradient,
  radius = 0,
  direction = 'vertical',
  start,
  end,
  locations,
  style,
  children,
  pointerEvents,
}: {
  gradient: GradientKey;
  /** Corner radius — a number, or a key from `radii`. */
  radius?: number | keyof typeof radii;
  /** Ignored when `start`/`end` are given explicitly. */
  direction?: 'vertical' | 'horizontal' | 'diagonal';
  start?: Point;
  end?: Point;
  /** Stop positions 0–1, one per color. Omit for an even spread. */
  locations?: readonly [number, number, ...number[]];
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  pointerEvents?: 'auto' | 'none' | 'box-none' | 'box-only';
}) {
  const [from, to] = DIRECTIONS[direction];
  const borderRadius = typeof radius === 'number' ? radius : radii[radius];

  return (
    <LinearGradient
      colors={gradients[gradient]}
      start={start ?? from}
      end={end ?? to}
      locations={locations}
      pointerEvents={pointerEvents}
      style={[borderRadius > 0 ? { borderRadius, overflow: 'hidden' } : null, style]}>
      {children}
    </LinearGradient>
  );
}

const DIRECTIONS: Record<'vertical' | 'horizontal' | 'diagonal', [Point, Point]> = {
  vertical: [
    { x: 0.5, y: 0 },
    { x: 0.5, y: 1 },
  ],
  horizontal: [
    { x: 0, y: 0.5 },
    { x: 1, y: 0.5 },
  ],
  diagonal: [
    { x: 0, y: 0 },
    { x: 1, y: 1 },
  ],
};

/**
 * A bottom-up scrim, for caption text over a photo. Absolute-positioned and
 * non-interactive — drop it in as the last child of the image container.
 */
export function ScrimDown({ height = 96, style }: { height?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <GradientSurface
      gradient="scrimDown"
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, { top: undefined, height }, style]}
    />
  );
}
