import type { ReactNode } from 'react';
import { useState } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { haptics, type HapticKind } from '@/lib/haptics';
import { SPRING, useMotion } from '@/lib/motion';

const Base = Animated.createAnimatedComponent(Pressable);

type PressState = { pressed: boolean };

/**
 * `Pressable` that springs down 4% under the finger instead of just dimming.
 *
 * This exists to retire the ~145 `pressed && styles.pressed` opacity sites in
 * the app. The swap is deliberately mechanical — the `style` prop takes the
 * exact same `({ pressed }) => …` callback Pressable takes, so converting a
 * call site is renaming the element and nothing else:
 *
 *   <Pressable style={({pressed}) => [s.row, pressed && s.pressed]}>
 *   <AnimatedPressable style={({pressed}) => [s.row, pressed && s.pressed]}>
 *
 * How the callback keeps working: Reanimated's animated components can't
 * resolve a FUNCTION style (they flatten `props.style` looking for animated
 * objects, and a function isn't one), so we track `pressed` ourselves off the
 * same press-in/press-out events Pressable uses internally, call the callback
 * with it, and hand the animated component a plain array. No wrapper `View`
 * is introduced — the layout of a converted call site is unchanged, which is
 * the whole point.
 *
 * Reduced motion: no scale. The press instead dims to 0.7, which is exactly
 * what the app did before, so nothing is lost.
 *
 * React Compiler: the scale is a shared value read only inside
 * `useAnimatedStyle` and written only from event handlers — never in render.
 */
export function AnimatedPressable({
  style,
  haptic,
  scaleTo = 0.96,
  onPressIn,
  onPressOut,
  children,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle> | ((state: PressState) => StyleProp<ViewStyle>);
  /** Fires on press-IN, so the buzz lands with the finger. Native only. */
  haptic?: HapticKind;
  /** How far down it presses. 1 disables the scale without disabling haptics. */
  scaleTo?: number;
  children?: ReactNode | ((state: PressState) => ReactNode);
}) {
  const motion = useMotion();
  const scale = useSharedValue(1);
  const [pressed, setPressed] = useState(false);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = (event: GestureResponderEvent) => {
    setPressed(true);
    if (motion.enabled) scale.value = withSpring(scaleTo, SPRING.press);
    if (haptic) haptics[haptic]();
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    setPressed(false);
    if (motion.enabled) scale.value = withSpring(1, SPRING.press);
    onPressOut?.(event);
  };

  const resolved = typeof style === 'function' ? style({ pressed }) : style;

  return (
    <Base
      {...rest}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[resolved, animatedStyle, !motion.enabled && pressed ? DIMMED : null]}>
      {typeof children === 'function' ? children({ pressed }) : children}
    </Base>
  );
}

/** The pre-Reanimated press convention, kept for reduced motion. */
const DIMMED: ViewStyle = { opacity: 0.7 };
