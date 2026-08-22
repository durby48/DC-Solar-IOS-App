import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect } from 'react';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
} from 'react-native-reanimated';

import { colors } from '@/constants/theme';
import { SPRING, useMotion } from '@/lib/motion';

/** The BASE Ionicons name — 'home', not 'home-outline'. */
export type TabIconName = keyof typeof Ionicons.glyphMap;

/**
 * A tab-bar icon that swaps outline → filled on focus and pops as it does.
 *
 * The outline/filled swap is the load-bearing part: it is the state cue that
 * still works for someone who can't distinguish the active tint. The bounce
 * is decoration on top of it, and disappears under reduced motion.
 *
 * Pass the base glyph name; the unfocused variant is `${name}-outline`, which
 * every Ionicon this app uses has.
 */
export function TabIcon({
  name,
  focused,
  size = 24,
  color = colors.accentPrimary,
  inactiveColor = colors.textMuted,
}: {
  name: TabIconName;
  focused: boolean;
  size?: number;
  color?: string;
  inactiveColor?: string;
}) {
  const { enabled } = useMotion();
  const scale = useSharedValue(1);

  useEffect(() => {
    if (!enabled || !focused) return;
    scale.value = withSequence(
      withSpring(1.18, SPRING.bouncy),
      withSpring(1, SPRING.bouncy),
    );
  }, [focused, enabled, scale]);

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const glyph = (focused ? name : `${name}-outline`) as TabIconName;

  return (
    <Animated.View style={animatedStyle}>
      <Ionicons name={glyph} size={size} color={focused ? color : inactiveColor} />
    </Animated.View>
  );
}
