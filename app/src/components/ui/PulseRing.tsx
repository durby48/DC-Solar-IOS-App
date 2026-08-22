import { useEffect } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, radii } from '@/constants/theme';
import { EASE, useMotion } from '@/lib/motion';

/**
 * A ring that breathes outward behind a control, to say "this is the thing
 * to press" — the Clock Out button while the clock is running.
 *
 * Non-interactive and absolutely positioned: drop it in as the FIRST child of
 * the button's container and it sits behind the label without changing the
 * layout or stealing the tap.
 *
 * Reduced motion: a still ring at rest. It keeps drawing the eye to the
 * control without anything on the screen moving forever — which is exactly
 * what a person who turned reduced motion on was asking for.
 */
export function PulseRing({
  color = colors.accentPrimary,
  radius = radii.pill,
  scaleTo = 1.35,
  duration = 1800,
  style,
}: {
  color?: string;
  /** Match the control's own corner radius. */
  radius?: number;
  scaleTo?: number;
  duration?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { enabled } = useMotion();
  const progress = useSharedValue(0);

  useEffect(() => {
    if (!enabled) return;
    progress.value = 0;
    progress.value = withRepeat(withTiming(1, { duration, easing: EASE.out }), -1, false);
    return () => {
      cancelAnimation(progress);
    };
  }, [enabled, duration, progress]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: 0.5 - progress.value * 0.5,
    transform: [{ scale: 1 + progress.value * (scaleTo - 1) }],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { borderRadius: radius, backgroundColor: color },
        enabled ? animatedStyle : styles.resting,
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  resting: {
    opacity: 0.22,
  },
});
