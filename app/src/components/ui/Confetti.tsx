import { useEffect, useMemo } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { accentCycle, colors } from '@/constants/theme';
import { EASE, useMotion } from '@/lib/motion';

const SHARD_COUNT = 24;
const DURATION_MS = 1600;

/** Brand hues plus the two leads, so a burst always reads as DC Solar. */
const SHARD_COLORS = [...accentCycle.map((entry) => entry.fg), colors.sun, colors.olive];

interface Shard {
  color: string;
  /** Fraction of the screen width where it starts. */
  startX: number;
  /** Sideways travel in px, signed. */
  drift: number;
  /** Downward travel in px. */
  fall: number;
  /** Full turns over the flight. */
  spin: number;
  width: number;
  height: number;
  /** 0–0.25 — staggers the burst so it doesn't fire as one sheet. */
  delay: number;
  radius: number;
}

function makeShards(width: number, height: number): Shard[] {
  return Array.from({ length: SHARD_COUNT }, (_, i) => {
    const size = 6 + Math.random() * 8;
    return {
      color: SHARD_COLORS[i % SHARD_COLORS.length],
      startX: 0.15 + Math.random() * 0.7,
      drift: (Math.random() - 0.5) * width * 0.7,
      fall: height * (0.55 + Math.random() * 0.45),
      spin: 1 + Math.random() * 3,
      width: size,
      height: size * (0.4 + Math.random() * 0.9),
      delay: Math.random() * 0.25,
      radius: Math.random() > 0.6 ? size / 2 : 2,
    };
  });
}

/**
 * A one-shot confetti burst for the three moments in this app worth
 * celebrating: clocking in, a job reaching Complete, and a payment recorded.
 *
 * Mount it when the thing happens, unmount it in `onDone`. It draws 24 plain
 * `View` shards over `absoluteFill` with `pointerEvents="none"`, so it never
 * eats a tap and needs no SVG or Lottie.
 *
 * ONE shared value drives all 24 — each shard reads the same 0→1 progress and
 * applies its own precomputed drift, fall, spin and delay in its worklet.
 * Twenty-four independent timings would be twenty-four animation drivers for
 * a decoration.
 *
 * Reduced motion: renders nothing and calls `onDone` immediately, so a caller
 * that clears state in `onDone` behaves identically either way.
 */
export function Confetti({ onDone }: { onDone?: () => void }) {
  const { enabled } = useMotion();
  const { width, height } = useWindowDimensions();
  const progress = useSharedValue(0);
  const shards = useMemo(() => makeShards(width, height), [width, height]);

  useEffect(() => {
    if (!enabled) {
      onDone?.();
      return;
    }
    progress.value = 0;
    progress.value = withTiming(1, { duration: DURATION_MS, easing: EASE.out }, (finished) => {
      if (finished && onDone) runOnJS(onDone)();
    });
    // One burst per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!enabled) return null;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {shards.map((shard, i) => (
        <Shard key={i} shard={shard} progress={progress} width={width} />
      ))}
    </View>
  );
}

function Shard({
  shard,
  progress,
  width,
}: {
  shard: Shard;
  progress: SharedValue<number>;
  width: number;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    // Each shard runs its own slice of the timeline, so the burst scatters.
    const local = Math.max(0, Math.min(1, (progress.value - shard.delay) / (1 - shard.delay)));
    return {
      opacity: local <= 0 ? 0 : 1 - local * local,
      transform: [
        { translateX: shard.drift * local },
        // Slight up-kick before gravity takes over.
        { translateY: shard.fall * local - 40 * local * (1 - local) * 2 },
        { rotate: `${shard.spin * 360 * local}deg` },
        { scale: 0.6 + local * 0.4 },
      ],
    };
  });

  return (
    <Animated.View
      style={[
        styles.shard,
        {
          left: width * shard.startX,
          width: shard.width,
          height: shard.height,
          borderRadius: shard.radius,
          backgroundColor: shard.color,
        },
        animatedStyle,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  shard: {
    position: 'absolute',
    // Starts just above the fold so it falls INTO the card that triggered it.
    top: '18%',
  },
});
