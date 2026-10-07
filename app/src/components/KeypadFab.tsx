import Ionicons from '@expo/vector-icons/Ionicons';
import { router, usePathname } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DialerWindow, LIVE_GREEN } from '@/components/phone/DialerWindow';
import { colors } from '@/constants/theme';
import { isLive, useCallSession } from '@/lib/callSession';
import { formatDuration, useCommsRealtime } from '@/lib/comms';
import { closeDialer, openDialer, refreshMissedCalls, useDialerWindow } from '@/lib/dialerWindow';
import { useRoleGate } from '@/lib/role';

/**
 * The Keypad button (2026-10-09, Carson) — round, BOTTOM-RIGHT on every sales
 * screen (it started top-right the same day). It opens the keypad WINDOW
 * (components/phone/DialerWindow: Keypad + Recents tabs) over the screen you
 * are on, and carries a red badge for missed calls you have not looked at.
 *
 * DURING A CALL it turns green with the timer — for anyone, not only sales —
 * and brings the call screen back: the call keeps going while you use the
 * app (lib/callSession.ts).
 *
 * Where it sits: above the tab bar on tab screens, above the bottom bar on
 * Assign leads, otherwise just above the bottom edge. Hidden on the call
 * screen, the public pages and — on a phone-sized screen — inside a CRM
 * message thread, where it would cover the composer (Conversation hides it).
 */

const HIDDEN = ['/keypad', '/call', '/brochure', '/join', '/card-saved', '/set-password', '/sign-up'];
/** Routes inside app/(tabs): the tab bar (62 tall) is under them. */
const TAB_ROUTES = ['/', '/workspace', '/schedule', '/calendar', '/map', '/settings', '/more', '/pipeline', '/customers'];
const TAB_BAR = 62;
/** Screens with their own bar along the bottom: sit above it. */
const BOTTOM_BARS: Record<string, number> = { '/assign-leads': 64 };
const SIZE = 52;

export function KeypadFab() {
  const gate = useRoleGate();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const { open, missed, hidden } = useDialerWindow();
  const session = useCallSession();
  const live = isLive(session);
  const isSales = gate.phase === 'ready' && gate.role?.isSales === true;

  // Leaving a screen closes the window (a tab change, a back gesture).
  const lastPath = useRef(pathname);
  useEffect(() => {
    if (lastPath.current !== pathname) closeDialer();
    lastPath.current = pathname;
  }, [pathname]);

  if (gate.phase !== 'ready' || !gate.role) return null;
  if (HIDDEN.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  if (!isSales && !live) return null;
  if (hidden && !open) return null;

  const bottom =
    (TAB_ROUTES.includes(pathname) ? TAB_BAR : insets.bottom + (BOTTOM_BARS[pathname] ?? 0)) + 14;

  return (
    <>
      {isSales ? <MissedCallWatcher pathname={pathname} /> : null}
      {isSales ? <DialerWindow anchorBottom={bottom + SIZE + 12} /> : null}
      <View pointerEvents="box-none" style={[styles.layer, { bottom }]}>
        {live && session ? (
          <Pressable
            onPress={() => {
              closeDialer();
              router.push('/call' as never);
            }}
            accessibilityRole="button"
            accessibilityLabel="Back to the call"
            style={({ pressed }) => [styles.liveButton, pressed && styles.pressed]}>
            <Ionicons name="call" size={18} color="#fff" />
            <LiveTime startedAt={session.state === 'active' ? session.startedAt : null} />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => (open ? closeDialer() : openDialer())}
            accessibilityRole="button"
            accessibilityLabel={open ? 'Close the keypad' : missed > 0 ? `Open the keypad, ${missed} missed calls` : 'Open the keypad'}
            hitSlop={6}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Ionicons name={open ? 'close' : 'keypad'} size={22} color={colors.textOnAction} />
            {missed > 0 && !open ? (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{missed > 99 ? '99+' : missed}</Text>
              </View>
            ) : null}
          </Pressable>
        )}
      </View>
    </>
  );
}

function LiveTime({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <Text style={styles.liveText}>
      {startedAt === null ? 'Calling…' : formatDuration(Math.max(0, Math.round((now - startedAt) / 1000)))}
    </Text>
  );
}

/** Keeps the missed-call badge current: on each screen, every minute, and when a call row changes. */
function MissedCallWatcher({ pathname }: { pathname: string }) {
  useEffect(() => {
    void refreshMissedCalls();
  }, [pathname]);
  useEffect(() => {
    const id = setInterval(() => void refreshMissedCalls(), 60_000);
    return () => clearInterval(id);
  }, []);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useCommsRealtime(
    useCallback(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refreshMissedCalls(), 2000);
    }, []),
  );
  return null;
}

const styles = StyleSheet.create({
  layer: { position: 'absolute', right: 16, zIndex: 150 },
  button: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.sun,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.danger,
    borderWidth: 2,
    borderColor: colors.surfaceAlt,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  liveButton: {
    height: SIZE,
    minWidth: SIZE,
    borderRadius: SIZE / 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    backgroundColor: LIVE_GREEN,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 8,
  },
  liveText: { color: '#fff', fontSize: 15, fontWeight: '800', fontVariant: ['tabular-nums'] },
  pressed: { opacity: 0.7 },
});
