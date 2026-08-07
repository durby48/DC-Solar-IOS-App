import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { recheckConnection, useConnection } from '@/lib/connection';

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
 */
export function ConnectionBanner() {
  const state = useConnection();
  const visible = state !== 'online';
  const slide = useRef(new Animated.Value(0)).current;
  // Keep the row mounted through the exit animation.
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) setMounted(true);
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: Platform.OS !== 'web',
    }).start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
  }, [visible, slide]);

  if (!mounted) return null;

  const offline = state === 'offline';

  return (
    <Animated.View
      style={[
        styles.wrap,
        offline ? styles.offline : styles.slow,
        {
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-60, 0] }) }],
        },
      ]}>
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
