import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Modal, PanResponder, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { RecentCallsList } from '@/components/phone/RecentCallsList';
import { SalesDialer } from '@/components/phone/SalesDialer';
import { colors, radii, spacing } from '@/constants/theme';
import { isLive, useCallSession } from '@/lib/callSession';
import { formatDuration } from '@/lib/comms';
import { closeDialer, markCallsSeen, openDialer, setDialerTab, useDialerWindow } from '@/lib/dialerWindow';

/**
 * The keypad WINDOW (2026-10-09, Carson: "it should not open a new screen but
 * rather a window and have a tab for recents").
 *
 *   Phone     a sheet sliding up over the screen you are on (85% tall);
 *             swipe it down or tap above it to close.
 *   Desktop   a phone-sized panel floating above the bottom-right button;
 *             the page behind stays usable.
 *
 * Two tabs, Keypad and Recents (components/phone/SalesDialer and
 * RecentCallsList). Anything that leaves — a call, a CRM record, Save as
 * prospect — closes the window first. Opening Recents clears the button's
 * missed-call badge. While a call is live a green bar returns to it.
 */
export function DialerWindow({ anchorBottom }: { /** Desktop: the panel sits this far up (above the button). */ anchorBottom: number }) {
  const { open, tab, preset, missed } = useDialerWindow();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const desktop = Platform.OS === 'web' && width >= 768;

  // Fresh numbers each time it opens.
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (open) setReloadKey((k) => k + 1);
  }, [open]);
  useEffect(() => {
    if (open && tab === 'recents') void markCallsSeen();
  }, [open, tab]);

  // SWIPE DOWN TO CLOSE (fixed 2026-10-09: the tabs' Pressables took the
  // touch first, so the old handler never fired). The top of the sheet —
  // grabber, tabs, close row — CAPTURES a downward drag even when it starts
  // on a tab; the sheet follows the finger, and a long or fast pull closes it.
  const drag = useRef(new Animated.Value(0)).current;
  const sheetHeight = Math.round(height * 0.85);
  const heightRef = useRef(sheetHeight);
  heightRef.current = sheetHeight;
  useEffect(() => {
    if (open) drag.setValue(0);
  }, [open, drag]);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => drag.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (g.dy > 80 || g.vy > 0.8) {
          Animated.timing(drag, { toValue: heightRef.current, duration: 160, useNativeDriver: true }).start(() =>
            closeDialer(),
          );
        } else {
          Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start();
        }
      },
      onPanResponderTerminate: () => Animated.spring(drag, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;

  const body = (
    <>
      <View style={styles.head} {...(desktop ? {} : pan.panHandlers)}>
        {desktop ? null : <View style={styles.grabber} />}
        <View style={styles.headRow}>
          <View style={styles.tabs}>
            {(
              [
                ['keypad', 'Keypad'],
                ['recents', 'Recents'],
              ] as const
            ).map(([key, label]) => (
              <Pressable
                key={key}
                onPress={() => setDialerTab(key)}
                accessibilityRole="tab"
                accessibilityState={{ selected: tab === key }}
                style={[styles.tab, tab === key && styles.tabOn]}>
                <Text style={[styles.tabText, tab === key && styles.tabTextOn]}>{label}</Text>
                {key === 'recents' && missed > 0 && tab !== 'recents' ? (
                  <View style={styles.tabBadge}>
                    <Text style={styles.tabBadgeText}>{missed > 99 ? '99+' : missed}</Text>
                  </View>
                ) : null}
              </Pressable>
            ))}
          </View>
          <Pressable onPress={closeDialer} accessibilityLabel="Close the keypad" hitSlop={8} style={styles.close}>
            <Ionicons name="close" size={20} color={colors.inkSoft} />
          </Pressable>
        </View>
        <LiveCallBar />
      </View>
      <View style={styles.body}>
        {tab === 'keypad' ? (
          <SalesDialer preset={preset} reloadKey={reloadKey} onLeave={closeDialer} />
        ) : (
          <RecentCallsList reloadKey={reloadKey} onLeave={closeDialer} onDialUnknown={(phone) => openDialer({ phone })} />
        )}
      </View>
    </>
  );

  if (desktop) {
    if (!open) return null;
    return (
      <View style={[styles.panel, { bottom: anchorBottom, height: Math.min(640, height - anchorBottom - 24) }]}>
        {body}
      </View>
    );
  }

  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={closeDialer}>
      <View style={styles.backdrop}>
        <Pressable style={styles.backdropTap} onPress={closeDialer} accessibilityLabel="Close the keypad" />
        <Animated.View
          style={[styles.sheet, { height: sheetHeight, paddingBottom: insets.bottom, transform: [{ translateY: drag }] }]}>
          {body}
        </Animated.View>
      </View>
    </Modal>
  );
}

/** "On call with … 2:31 · Return" while a call is live. */
function LiveCallBar() {
  const session = useCallSession();
  const live = isLive(session);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [live]);
  if (!session || !live) return null;
  const time =
    session.state === 'active' && session.startedAt !== null
      ? formatDuration(Math.max(0, Math.round((now - session.startedAt) / 1000)))
      : 'Calling…';
  return (
    <Pressable
      onPress={() => {
        closeDialer();
        router.push('/call' as never);
      }}
      style={({ pressed }) => [styles.liveBar, pressed && styles.pressed]}>
      <Ionicons name="call" size={14} color="#fff" />
      <Text style={styles.liveText} numberOfLines={1}>
        On call with {session.name} · {time}
      </Text>
      <Text style={styles.liveReturn}>Return</Text>
    </Pressable>
  );
}

export const LIVE_GREEN = '#2E9E5B';

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  backdropTap: { flex: 1 },
  sheet: {
    backgroundColor: colors.surfaceAlt,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    overflow: 'hidden',
  },
  panel: {
    position: Platform.OS === 'web' ? ('fixed' as 'absolute') : 'absolute',
    right: 20,
    width: 380,
    zIndex: 160,
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.line,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 12,
  },
  head: { paddingHorizontal: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.xs, gap: spacing.sm },
  grabber: { alignSelf: 'center', width: 40, height: 5, borderRadius: 3, backgroundColor: colors.line },
  headRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  tabs: { flex: 1, flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radii.pill, padding: 3 },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    borderRadius: radii.pill,
  },
  tabOn: { backgroundColor: colors.sun },
  tabText: { color: colors.inkSoft, fontSize: 13, fontWeight: '800' },
  tabTextOn: { color: colors.textOnAction },
  tabBadge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger,
  },
  tabBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  close: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface },
  liveBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: LIVE_GREEN,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  liveText: { flex: 1, color: '#fff', fontSize: 13, fontWeight: '800' },
  liveReturn: { color: '#fff', fontSize: 13, fontWeight: '800', textDecorationLine: 'underline' },
  body: { flex: 1 },
  pressed: { opacity: 0.7 },
});
