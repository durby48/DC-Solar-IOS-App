import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect } from 'expo-router';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useRef } from 'react';
import { Platform, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { DURATION, EASE, SPRING, useMotion } from '@/lib/motion';

/**
 * Tips a card toward the light and slides a specular band across it, so a holo
 * card behaves the way a holo card behaves in your hand.
 *
 * TWO INPUTS, ONE OUTPUT. On a phone the tilt comes from `DeviceMotion` —
 * physically turning the phone turns the card. On the web there is no gyro
 * worth trusting, so a pan gesture stands in: drag across the card and it
 * leans. Both write the same two shared values, and everything downstream
 * (the 3D transform, the glare) reads only those.
 *
 * THE SUBSCRIPTION IS SCOPED TO FOCUS, NOT TO MOUNT. `useFocusEffect` tears
 * the listener down when you navigate away, because a 60 ms sensor stream left
 * running behind three pushed screens is a battery bug that only shows up on
 * someone else's phone.
 *
 * The first sample becomes the neutral position. A phone is never held flat,
 * so treating raw beta as zero would leave every card permanently pitched back
 * about forty degrees.
 *
 * Reduced motion: no listener, no gesture, no glare — just the children.
 */
export function TiltCard({
  children,
  width,
  height,
  radius = 0,
  maxTilt = 12,
  glare = true,
  style,
}: {
  children: ReactNode;
  width: number;
  height: number;
  /** Corner radius for the glare overlay, so it can't spill past the card. */
  radius?: number;
  /** Degrees, each axis. The print sheet's cards are not bendy. */
  maxTilt?: number;
  glare?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const motion = useMotion();
  const tiltX = useSharedValue(0);
  const tiltY = useSharedValue(0);
  /** First sensor sample, in degrees. Plain ref — never read during render. */
  const neutral = useRef<{ beta: number; gamma: number } | null>(null);

  const enabled = motion.enabled;
  const isWeb = Platform.OS === 'web';

  // --- native: device motion ------------------------------------------------
  useFocusEffect(
    useCallback(() => {
      if (isWeb || !enabled) return;

      let cancelled = false;
      let subscription: { remove: () => void } | null = null;

      const clamp = (value: number) => Math.max(-maxTilt, Math.min(maxTilt, value));

      const start = async () => {
        try {
          const available = await DeviceMotion.isAvailableAsync();
          if (!available || cancelled) return;
          DeviceMotion.setUpdateInterval(60);
          subscription = DeviceMotion.addListener((event: DeviceMotionMeasurement) => {
            const rotation = event?.rotation;
            if (!rotation) return;
            const beta = toDegrees(rotation.beta);
            const gamma = toDegrees(rotation.gamma);
            if (!neutral.current) neutral.current = { beta, gamma };
            const base = neutral.current;
            // Rolling the phone right should turn the card's right edge away,
            // which is a POSITIVE rotateY; pitching it forward tips the top
            // toward you, which is a positive rotateX.
            tiltY.value = withSpring(clamp(gamma - base.gamma), SPRING.gentle);
            tiltX.value = withSpring(clamp(-(beta - base.beta)), SPRING.gentle);
          });
        } catch {
          // A device with no motion sensor simply doesn't tilt.
        }
      };
      void start();

      return () => {
        cancelled = true;
        subscription?.remove();
        neutral.current = null;
        tiltX.value = withTiming(0, { duration: DURATION.fast, easing: EASE.out });
        tiltY.value = withTiming(0, { duration: DURATION.fast, easing: EASE.out });
      };
    }, [enabled, isWeb, maxTilt, tiltX, tiltY]),
  );

  // --- web: pan gesture -----------------------------------------------------
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isWeb && enabled)
        .onUpdate((event) => {
          'worklet';
          const clamp = (value: number) => Math.max(-maxTilt, Math.min(maxTilt, value));
          tiltY.value = clamp((event.translationX / Math.max(1, width / 2)) * maxTilt);
          tiltX.value = clamp((-event.translationY / Math.max(1, height / 2)) * maxTilt);
        })
        .onFinalize(() => {
          'worklet';
          tiltY.value = withSpring(0, SPRING.gentle);
          tiltX.value = withSpring(0, SPRING.gentle);
        }),
    [enabled, isWeb, maxTilt, width, height, tiltX, tiltY],
  );

  const cardStyle = useAnimatedStyle(() => ({
    transform: [
      { perspective: 900 },
      { rotateX: `${tiltX.value}deg` },
      { rotateY: `${tiltY.value}deg` },
    ],
  }));

  /**
   * The holo sweep: a soft band that slides across the card as it leans, and
   * brightens the further it is from flat. The `rotate` has to live inside the
   * animated transform — a `transform` in the static style would be replaced
   * wholesale by this one rather than merged with it.
   */
  const glareStyle = useAnimatedStyle(() => {
    const lean = (Math.abs(tiltX.value) + Math.abs(tiltY.value)) / (maxTilt * 2);
    return {
      opacity: Math.min(0.45, 0.08 + lean * 0.5),
      transform: [
        { translateX: (tiltY.value / maxTilt) * width * 0.55 },
        { translateY: (tiltX.value / maxTilt) * height * 0.18 },
        { rotate: '20deg' },
      ],
    };
  });

  if (!enabled) {
    return <View style={[{ width, height }, style]}>{children}</View>;
  }

  const body = (
    <Animated.View style={[{ width, height }, cardStyle, style]}>
      {children}
      {glare ? (
        <View style={[styles.clip, { borderRadius: radius }]}>
          <Animated.View
            style={[
              styles.glare,
              { width: width * 0.6, height: height * 1.8, left: -width * 0.12 },
              glareStyle,
            ]}>
            <LinearGradient
              colors={['rgba(255,255,255,0)', 'rgba(255,255,255,0.85)', 'rgba(255,255,255,0)']}
              start={{ x: 0, y: 0.5 }}
              end={{ x: 1, y: 0.5 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>
      ) : null}
    </Animated.View>
  );

  if (!isWeb) return body;
  return <GestureDetector gesture={pan}>{body}</GestureDetector>;
}

/**
 * `DeviceMotion.rotation` is documented in degrees but arrives in radians on
 * iOS (Core Motion's attitude is radians and Expo passes it straight through).
 * Anything past ±π can only be degrees, so the units are detected rather than
 * assumed — guessing wrong makes the card either immobile or seasick.
 */
function toDegrees(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.abs(value) > Math.PI + 0.1 ? value : (value * 180) / Math.PI;
}

const styles = StyleSheet.create({
  /** `pointerEvents` in the style, not the prop — the prop is deprecated. */
  clip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    pointerEvents: 'none',
  },
  glare: {
    position: 'absolute',
    top: '-40%',
  },
});
