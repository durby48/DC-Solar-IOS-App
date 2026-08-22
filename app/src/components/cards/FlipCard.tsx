import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { haptics } from '@/lib/haptics';
import { DURATION, EASE, useMotion } from '@/lib/motion';

/**
 * Tap to turn a card over.
 *
 * Both faces are stacked in the same box, each with its own perspective and a
 * hidden backface, and one 0→1 shared value rotates them 180° apart. That is
 * the whole trick: at progress 0 the front is at 0° (visible) and the back at
 * 180° (hidden); at progress 1 they have swapped. No `transformStyle:
 * preserve-3d` is needed, which matters because react-native-web is the only
 * platform of the three that implements it.
 *
 * The flip direction is deliberately always the same way round. Alternating
 * it based on which face is showing reads as the card wobbling rather than
 * turning.
 *
 * Reduced motion: the faces swap instantly (`withTiming` with a 0 duration
 * lands on the frame it is called). The card still flips — a person who turned
 * animation off still wants to see the back.
 */
export function FlipCard({
  front,
  back,
  width,
  height,
  flipped,
  onFlip,
  disabled = false,
  style,
}: {
  /** The face shown first. In a pack that is the PRINTED BACK, not the card. */
  front: ReactNode;
  back: ReactNode;
  width: number;
  height: number;
  /**
   * Controlled mode: pass it and the parent owns which face is showing (the
   * pack reveal drives five of these off one stagger). Omit it and a tap
   * toggles the card itself.
   */
  flipped?: boolean;
  /** Called with the new face after each tap. */
  onFlip?: (showingBack: boolean) => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const motion = useMotion();
  const [internal, setInternal] = useState(false);
  const showBack = flipped ?? internal;
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withTiming(showBack ? 1 : 0, {
      duration: motion.ms(DURATION.slow),
      easing: EASE.standard,
    });
  }, [showBack, motion, progress]);

  const frontStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 900 }, { rotateY: `${progress.value * 180}deg` }],
  }));

  const backStyle = useAnimatedStyle(() => ({
    transform: [{ perspective: 900 }, { rotateY: `${progress.value * 180 + 180}deg` }],
  }));

  const handlePress = () => {
    const next = !showBack;
    if (flipped === undefined) setInternal(next);
    haptics.tapLight();
    onFlip?.(next);
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={showBack ? 'Show the front of the card' : 'Show the back of the card'}
      style={[{ width, height }, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.face, frontStyle]}>
        {front}
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, styles.face, backStyle]}>{back}</Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  face: {
    backfaceVisibility: 'hidden',
  },
});
