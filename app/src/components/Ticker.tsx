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
 * The item track is rendered end to end enough times to more than cover the
 * viewport, then translated by exactly one track width, so when the
 * animation resets, the next copy is sitting precisely where the first one
 * started — no visible jump. Two copies is only enough when one lap of items
 * is wider than the visible strip; on a screen wider than that (web, tablet)
 * two copies run out mid-loop and leave a blank gap right before the reset,
 * which reads as the marquee cutting off and restarting instead of looping.
 * So the copy count scales with how the measured track width compares to the
 * measured viewport width, both via `onLayout` rather than assumed.
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
  paused = false,
}: {
  /** Rendered twice — keep them cheap. */
  items: ReactNode[];
  /** Pixels per second. Slow enough to read. */
  speed?: number;
  style?: StyleProp<ViewStyle>;
  /**
   * Stop the marquee without unmounting it. Pass `!isFocused` — an infinite
   * `withRepeat` keeps its UI-thread frame callback alive on a screen nobody
   * is looking at, and the pipeline hero already parks its own animation the
   * same way. Restarting from 0 rather than resuming mid-scroll is deliberate:
   * the track's two copies are identical, so frame 0 is visually the same
   * place as any repetition boundary and nothing appears to jump.
   */
  paused?: boolean;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const [viewportWidth, setViewportWidth] = useState(0);
  const { enabled } = useMotion();
  const translateX = useSharedValue(0);

  useEffect(() => {
    if (trackWidth <= 0 || !enabled || paused) {
      cancelAnimation(translateX);
      // Park on the frame where copy one starts, not wherever it stopped.
      translateX.value = 0;
      return;
    }
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
  }, [trackWidth, enabled, speed, paused, translateX]);

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

  // At least 2 copies (the minimum for the reset trick to be invisible), or
  // enough to span the viewport plus one extra lap so there's always a copy
  // waiting off the right edge.
  const copies =
    trackWidth > 0 ? Math.max(2, Math.ceil(viewportWidth / trackWidth) + 1) : 2;

  return (
    <View
      style={[styles.viewport, style]}
      pointerEvents="none"
      onLayout={(event) => setViewportWidth(event.nativeEvent.layout.width)}>
      <Animated.View style={[styles.row, animatedStyle]}>
        {Array.from({ length: copies }, (_, copyIndex) => (
          <View
            key={`copy-${copyIndex}`}
            style={styles.row}
            onLayout={
              copyIndex === 0
                ? (event) => setTrackWidth(event.nativeEvent.layout.width)
                : undefined
            }>
            {items.map((item, i) => (
              <View key={`${copyIndex}-${i}`}>{item}</View>
            ))}
          </View>
        ))}
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
