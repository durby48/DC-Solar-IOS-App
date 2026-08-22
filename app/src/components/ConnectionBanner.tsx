import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { recheckConnection, useConnection } from '@/lib/connection';
import { DURATION, EASE, useMotion } from '@/lib/motion';

/**
 * Tells the crew when the app can't reach the office.
 *
 * A banner rather than a modal on purpose: an installer halfway up a ladder
 * shouldn't have to dismiss a dialog to see the address they're standing at.
 * It's unmissable — full-width, coloured, animated in — but never blocks the
 * screen, and it can't be dismissed while the problem is real.
 *
 * The wording is deliberately specific about what survives. Clock in/out is
 * saved on the phone and syncs later; everything else (hours, photos, finance,
 * stage changes) genuinely does not reach the office until the bars come back.
 * Saying "you're offline" without saying what that costs is how people lose an
 * afternoon of logged hours.
 *
 * 2026-08-22: converted to Reanimated. The `mounted` latch is unchanged and
 * still the point — the row has to stay in the tree through the EXIT
 * animation or the banner would vanish instantly instead of sliding away.
 * What's new is that the unmount is triggered from the animation's own
 * completion callback on the UI thread via `runOnJS`, rather than from an RN
 * `Animated` start callback.
 */
export function ConnectionBanner() {
  const state = useConnection();
  const visible = state !== 'online';
  const { enabled } = useMotion();
  const slide = useSharedValue(visible ? 1 : 0);
  // Keep the row mounted through the exit animation.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    slide.value = withTiming(
      visible ? 1 : 0,
      { duration: enabled ? DURATION.base - 20 : 0, easing: EASE.out },
      (finished) => {
        if (finished && !visible) runOnJS(setMounted)(false);
      },
    );
  }, [visible, enabled, slide]);

  const animatedStyle = useAnimatedStyle(() => ({
    opacity: slide.value,
    // -60 → 0: it drops in from above the safe area.
    transform: [{ translateY: -60 + slide.value * 60 }],
  }));

  if (!mounted) return null;

  const offline = state === 'offline';

  return (
    <Animated.View
      style={[styles.wrap, offline ? styles.offline : styles.slow, animatedStyle]}>
      <Ionicons
        name={offline ? 'cloud-offline' : 'cellular'}
        size={18}
        color={offline ? colors.white : colors.ink}
      />
      <View style={styles.text}>
        <Text style={[styles.title, !offline && styles.titleDark]}>
          {offline ? "You're offline" : 'Weak signal'}
        </Text>
        <Text style={[styles.body, !offline && styles.bodyDark]}>
          {offline
            ? 'Changes you make now are NOT reaching the office. Clock in/out is saved on this phone and will sync — hours, photos and edits will not.'
            : 'The connection is very slow. Saves may take a while or time out — check anything important actually saved.'}
        </Text>
      </View>
      <Pressable
        onPress={recheckConnection}
        hitSlop={8}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
        <Text style={[styles.retryText, !offline && styles.retryTextDark]}>Retry</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderRadius: radii.md,
    marginHorizontal: spacing.sm,
    marginTop: spacing.sm,
    ...shadows.raised,
  },
  offline: { backgroundColor: colors.danger },
  slow: { backgroundColor: colors.sunLight },
  text: { flex: 1, gap: 1 },
  title: { color: colors.white, fontSize: 14, fontWeight: '800' },
  titleDark: { color: colors.ink },
  body: { color: 'rgba(255,255,255,0.92)', fontSize: 11, lineHeight: 15, fontWeight: '600' },
  bodyDark: { color: colors.inkSoft },
  retry: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  retryText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  retryTextDark: { color: colors.ink },
  pressed: { opacity: 0.7 },
});
