import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
  const [reduceMotion, setReduceMotion] = useState(false);
  const translateX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let cancelled = false;
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then((enabled) => {
        if (!cancelled) setReduceMotion(Boolean(enabled));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (trackWidth <= 0 || reduceMotion) return;
    translateX.setValue(0);
    const animation = Animated.loop(
      Animated.timing(translateX, {
        toValue: -trackWidth,
        duration: (trackWidth / speed) * 1000,
        easing: Easing.linear,
        // RN-Web can't drive transforms off the JS thread.
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    animation.start();
    return () => animation.stop();
  }, [trackWidth, reduceMotion, speed, translateX]);

  if (reduceMotion) {
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
      <Animated.View style={[styles.row, { transform: [{ translateX }] }]}>
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
