import { useEffect, useState } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, radii, spacing } from '@/constants/theme';
import { useMotion } from '@/lib/motion';
import { GradientSurface } from './GradientSurface';

/**
 * A loading placeholder in the shape of the thing that's coming.
 *
 * A skeleton beats a spinner here because this app's screens refetch on every
 * focus: a spinner says "wait", a skeleton says "the layout you remember is
 * still the layout you're getting". It also stops the page height jumping
 * when the data lands.
 *
 * The sweep is a `gradients.shimmer` band translated across the block. It is
 * measured with `onLayout` rather than assumed, so a skeleton works at any
 * width including `'100%'`.
 *
 * Reduced motion: the flat tinted block, no sweep. Still a skeleton, just a
 * still one.
 */
export function Skeleton({
  width = '100%',
  height = 16,
  radius = radii.sm,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { enabled } = useMotion();
  const [measured, setMeasured] = useState(0);
  const offset = useSharedValue(0);

  useEffect(() => {
    if (!enabled || measured <= 0) return;
    offset.value = -measured;
    offset.value = withRepeat(
      withTiming(measured, { duration: 1200, easing: Easing.linear }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(offset);
    };
  }, [enabled, measured, offset]);

  const sweep = useAnimatedStyle(() => ({ transform: [{ translateX: offset.value }] }));

  return (
    <View
      accessibilityRole="progressbar"
      accessibilityLabel="Loading"
      onLayout={(event) => setMeasured(event.nativeEvent.layout.width)}
      style={[styles.block, { width, height, borderRadius: radius }, style]}>
      {enabled && measured > 0 ? (
        // The transform rides an Animated.View, not the gradient itself:
        // `GradientSurface` is a plain function component with no forwarded
        // ref, so `createAnimatedComponent` would have nothing to drive.
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { width: measured }, sweep]}>
          <GradientSurface gradient="shimmer" direction="horizontal" style={styles.fill} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * A stack of skeleton rows, for a list that hasn't loaded. `count` should
 * match roughly what the screen usually shows — three rows for a short list,
 * five or six for a long one.
 */
export function SkeletonList({
  count = 3,
  height = 56,
  gap = spacing.sm,
  radius = radii.md,
  style,
}: {
  count?: number;
  height?: number;
  gap?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ gap }, style]}>
      {Array.from({ length: Math.max(1, count) }, (_, i) => (
        <Skeleton key={i} height={height} radius={radius} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: colors.surfaceSunk,
    overflow: 'hidden',
  },
  fill: {
    flex: 1,
  },
});
