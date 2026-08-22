import type { ReactNode } from 'react';
import { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

import { DURATION, EASE, useMotion } from '@/lib/motion';

/**
 * Fades a block in and lifts it 12px into place. Pass `index` and a list of
 * them arrives as a stagger.
 *
 * Written with a manual shared value rather than Reanimated's `entering={}`
 * layout animations on purpose:
 *   • layout animations are a no-op on react-native-web, and half this app's
 *     users are on app.dcsolarkc.com;
 *   • `entering` fires again on every remount, which for a `useFocusEffect`
 *     screen means the whole list re-animates each time you come back from a
 *     job — this runs once per mount and then leaves the value alone;
 *   • it needs no `LayoutAnimationConfig` provider anywhere up the tree.
 *
 * Reduced motion: the shared value STARTS at 1, so the content is simply
 * there on the first frame — no flash of invisible content.
 */
export function FadeInUp({
  index = 0,
  distance = 12,
  duration = DURATION.base,
  delay = 0,
  style,
  children,
}: {
  /** Position in a staggered group. Capped at STAGGER_CAP inside `useMotion`. */
  index?: number;
  /** How far it travels upward. */
  distance?: number;
  duration?: number;
  /** Extra delay on top of the stagger, e.g. to wait for data. */
  delay?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const motion = useMotion();
  const progress = useSharedValue(motion.enabled ? 0 : 1);

  useEffect(() => {
    if (!motion.enabled) {
      progress.value = 1;
      return;
    }
    progress.value = withDelay(
      motion.delay(index) + delay,
      withTiming(1, { duration, easing: EASE.standard }),
    );
    // Intentionally runs once per mount: re-running on `index` changes would
    // re-animate rows as a list re-sorts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ translateY: (1 - progress.value) * distance }],
  }));

  return <Animated.View style={[style, animatedStyle]}>{children}</Animated.View>;
}
