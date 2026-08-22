import { type ReactNode, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useMotion } from '@/lib/motion';

/**
 * Seamless horizontal marquee, stock-ticker style.
 *
 * The item track is rendered TWICE end to end and translated by exactly one
 * track width, so when the animation resets, copy two is sitting precisely
 * where copy one started — no visible jump. The track width is measured with
 * `onLayout` rather than assumed, which is what makes it work with items of
 * any width.
 *
 * Falls back to a plain horizontal scroller when the OS reports "reduce
 * motion" — a permanently moving element is a genuine problem for some people.
 *
 * Items must supply their own trailing margin (not `gap`), so each copy
 * measures identically including its spacing.
 *
 * Extracted from JobFinanceHeader 2026-08-05 so the pipeline hero and the job
 * finance strip share one implementation.
 *
 * 2026-08-22: converted from RN `Animated` to Reanimated. The old version
 * fell back to a JS-driven transform on web (`useNativeDriver: false`), which
 * meant a permanent 60fps JS-thread loop on app.dcsolarkc.com; Reanimated
 * runs it off the JS thread on every platform. The reduce-motion check also
 * moved from a one-shot `AccessibilityInfo` promise to `useMotion()`, the
 * app's single gate.
 */
export function Ticker({
  items,
  speed = 38,
  style,
}: {
  /** Rendered twice — keep them cheap. */
  items: ReactNode[];
  /** Pixels per second. Slow enough to read. */
  speed?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const { enabled } = useMotion();
  const translateX = useSharedValue(0);

  useEffect(() => {
    if (trackWidth <= 0 || !enabled) return;
    translateX.value = 0;
    translateX.value = withRepeat(
      withTiming(-trackWidth, {
        duration: (trackWidth / speed) * 1000,
        easing: Easing.linear,
      }),
      // Forever, and not reversed: each repetition restarts from 0, which is
      // the frame where copy two lines up with where copy one began.
      -1,
      false,
    );
    return () => {
      cancelAnimation(translateX);
    };
  }, [trackWidth, enabled, speed, translateX]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  if (!enabled) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.viewport, style]}
        contentContainerStyle={styles.row}>
        {items.map((item, i) => (
          <View key={`static-${i}`}>{item}</View>
        ))}
      </ScrollView>
    );
  }

  return (
    <View style={[styles.viewport, style]} pointerEvents="none">
      <Animated.View style={[styles.row, animatedStyle]}>
        <View
          style={styles.row}
          onLayout={(event) => setTrackWidth(event.nativeEvent.layout.width)}>
          {items.map((item, i) => (
            <View key={`a-${i}`}>{item}</View>
          ))}
        </View>
        {/* Second copy: what the eye sees once copy one scrolls off. */}
        <View style={styles.row}>
          {items.map((item, i) => (
            <View key={`b-${i}`}>{item}</View>
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  viewport: {
    flexGrow: 0,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
  },
});
