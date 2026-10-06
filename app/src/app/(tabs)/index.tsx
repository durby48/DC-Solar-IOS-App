import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import BuildInfo from '@/components/BuildInfo';
import { ClockCard } from '@/components/ClockCard';
import { DeleteAccount } from '@/components/DeleteAccount';
import { HomeHeader } from '@/components/HomeHeader';
import { SalesHome } from '@/components/sales/SalesHome';
import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  FadeInUp,
  ListRow,
  Screen,
  SectionHeader,
  Tile,
} from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { explainAdminOnly, isLockedFor } from '@/lib/adminGate';
import { getSessionEmail } from '@/lib/clock';
import { fetchUnreadCount } from '@/lib/comms';
import { fetchJobs, fetchScheduleEntries } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import { HUBS } from '@/lib/hub';
import { type Job } from '@/lib/types';
import { registerPushToken, scheduleJobReminders } from '@/lib/notifications';
import { registerForIncomingCalls } from '@/lib/voice';
import { useRoleGate } from '@/lib/role';
import { signOutAndLeave } from '@/lib/signOut';

/**
 * Home — the hub the app opens to.
 *
 * The greeting header (white surface, five-colour hub stripe — 2026-09-13,
 * no longer an olive band), the clock card under it, today's work, and then
 * the FIVE HUBS (2026-09-12 overhaul): CRM,
 * Pipeline, Operations, Human Resources, Systems Management. Each hub is one
 * colour-edged tile in its own hue (`hubColors`), and every role sees all
 * five — Systems Management is drawn LOCKED for the crew and explains itself
 * on tap instead of navigating (`lib/adminGate.ts`). The per-item grid that
 * used to live here moved into the hub screens and the Menu tab.
 *
 * There is no role-dependent layout any more, so there is no skeleton phase
 * either: the grid renders at once and the lock badge lands when the role
 * does. `isAdmin` is still `ready && isAdmin === true` — an unknown role is
 * not an admin, and the only thing that costs is a lock badge on one tile.
 *
 * The hub list itself lives in `lib/hub.ts`, shared with the Menu tab.
 *
 * SALES (2026-10-06, S1). A `sales` login gets `components/sales/SalesHome`
 * as the whole screen (its own header with their number, three boxes, New
 * prospect); their Account rows live on the Settings tab. Because a rep's
 * role decides the whole body, the body waits for the role here (the cached
 * role makes that a beat), so a rep never sees the crew's hubs flash.
 * Home is also where push and incoming-call registration run, which is why
 * reps must be able to reach it: before this they were confined to the CRM
 * and their iPhone never registered for either.
 */

/** Two columns on a phone, five (one per hub) on a desktop browser. */
const WIDE_BREAKPOINT = 900;

export default function HomeScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const gate = useRoleGate();
  const isAdmin = gate.phase === 'ready' && gate.role?.isAdmin === true;
  const isSales = gate.phase === 'ready' && gate.role?.isSales === true;

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [unread, setUnread] = useState(0);


  useEffect(() => {
    let cancelled = false;
    getSessionEmail().then((email) => {
      if (!cancelled) setSessionEmail(email);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The root layout's `<StatusBar style="light" />` suits the cactus band and
  // the charcoal page alike, so there is no per-screen status-bar flip here.

  useFocusEffect(
    useCallback(() => {
      // The Sales Home loads its own data; the crew's job reads are not theirs.
      if (gate.phase !== 'ready' || isSales) return;
      let cancelled = false;
      fetchJobs().then(({ jobs: fetched }) => {
        if (!cancelled) setJobs(fetched);
      });
      // "Today · N jobs" counts SCHEDULED work, not jobs whose one date
      // happens to be today — a two-day install shows on both of its days.
      fetchScheduleEntries().then(({ entries }) => {
        if (cancelled) return;
        const today = todayISO();
        const ids = new Set(
          entries.filter((e) => e.work_date === today).map((e) => e.job.id),
        );
        setTodayCount(ids.size);
      });
      /**
       * `messages` is admin-only in RLS, so this comes back 0 for the crew
       * and no badge appears. The gate is the database's, not this screen's.
       */
      void fetchUnreadCount().then((count) => {
        if (!cancelled) setUnread(count);
      });
      return () => {
        cancelled = true;
      };
    }, [gate.phase, isSales]),
  );

  /**
   * Signed-in devices: keep 24h/1h job reminders synced with the schedule and
   * register this device's push token. Home is the screen everyone opens, so
   * it is the reliable place to do it. Both are silent no-ops on web and on
   * denied permission.
   */
  useEffect(() => {
    if (!sessionEmail) return;
    // Registration must not wait for jobs: a new operator with nothing
    // scheduled yet (or a viewer) still needs texts and leads to reach them.
    void registerPushToken(sessionEmail);
    if (jobs.length > 0) void scheduleJobReminders(jobs);
  }, [sessionEmail, jobs]);

  // Incoming calls ring this phone like a real call (CallKit) once the
  // Twilio push credential exists; until then this is a silent no-op. The
  // result is recorded to client_diagnostics by the voice module itself.
  // Re-run whenever the app comes back to the foreground: the PushKit
  // token and the Twilio binding can both change while it was away.
  useEffect(() => {
    // Sales reps too: calls to their own DC Solar number ring them.
    if (!sessionEmail || !(isAdmin || isSales)) return;
    void registerForIncomingCalls();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registerForIncomingCalls();
    });
    return () => sub.remove();
  }, [sessionEmail, isAdmin, isSales]);

  // Shared helper: ends the session (with a timeout) and resets the ROOT
  // stack to the login route. `router.replace('/')` from inside the tabs
  // resolves to the Home tab, which is why the old button looked dead.
  const signOut = () => signOutAndLeave(navigation);



  // A rep's whole Home is its own screen (header included); the hooks above
  // still run for them — push and incoming-call registration live there.
  if (isSales) return <SalesHome />;

  const wide = width >= WIDE_BREAKPOINT;
  // One row of five on a desktop browser; two columns on a phone.
  const columns = wide ? HUBS.length : 2;
  const compact = Platform.OS === 'web' && wide;

  return (
    <Screen padded={false} edges={[]} contentContainerStyle={styles.scroll}>
      <HomeHeader />

      <View style={[styles.body, compact && styles.bodyCompact]}>
        {gate.phase === 'loading' ? (
          <ActivityIndicator color={colors.accentPrimary} style={styles.roleWait} />
        ) : (
          <>
            <ClockCard style={styles.clock} />

            <FadeInUp index={0}>
              <Card padded={false} style={styles.todayCard}>
                <ListRow
                  icon="today"
                  iconColor={hubColors.operations.fg}
                  iconBackground={hubColors.operations.bg}
                  title={
                    todayCount === null
                      ? 'Today'
                      : `Today · ${todayCount} ${todayCount === 1 ? 'job' : 'jobs'}`
                  }
                  subtitle="Open the schedule"
                  onPress={() => router.push('/calendar')}
                />
              </Card>
            </FadeInUp>

            <View style={styles.section}>
              <SectionHeader title="Hubs" subtitle="Everything in the app, five doors" />
              <View style={styles.grid}>
                {HUBS.map((hub, i) => {
                  // Only a CONFIRMED non-admin gets the lock; while the role is
                  // loading the tile is drawn open and the press still explains
                  // (the gate below re-checks at tap time with the same rule).
                  const locked = gate.phase === 'ready' && isLockedFor(hub.gate, isAdmin);
                  return (
                    <FadeInUp
                      key={hub.key}
                      index={1 + i}
                      style={[styles.cell, { width: `${100 / columns}%` }]}>
                      <Tile
                        title={hub.title}
                        subtitle={hub.subtitle}
                        icon={hub.icon}
                        tone={hub.key}
                        compact={compact}
                        locked={locked}
                        badge={hub.key === 'crm' ? unread : undefined}
                        onPress={() => {
                          if (isLockedFor(hub.gate, isAdmin)) explainAdminOnly();
                          else router.push(hub.href);
                        }}
                        style={styles.tile}
                      />
                    </FadeInUp>
                  );
                })}
              </View>
            </View>
          </>
        )}

        <View style={styles.section}>
          <SectionHeader title="Account" />
          <Card padded={false}>
            <ListRow
              icon="log-out"
              title="Sign out"
              danger
              chevron={false}
              onPress={signOut}
            />
          </Card>
        </View>

        {/* Required by App Store guideline 5.1.1(v) for any app with accounts. */}
        <DeleteAccount />

        {/* Which build + OTA update this device runs; tap to check for a newer one. */}
        <BuildInfo />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: {
    paddingBottom: spacing.xl,
  },
  body: {
    paddingHorizontal: spacing.lg,
    gap: spacing.md,
  },
  /** The desktop browser: less air around the grid, a little more at the sides. */
  bodyCompact: {
    gap: spacing.sm + 2,
    paddingHorizontal: spacing.xl,
  },
  roleWait: {
    marginVertical: spacing.xl,
  },
  /** Sits under the header like any other card — no overlap trick any more. */
  clock: {
    marginTop: spacing.xs,
  },
  todayCard: {
    marginTop: spacing.xs,
  },
  section: {
    marginTop: spacing.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // Negative gutters so the outer cells sit flush with the page padding
    // while the tiles keep even spacing between them.
    marginHorizontal: -spacing.xs,
  },
  cell: {
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.sm,
  },
  tile: {
    // The tile's own `minWidth` would blow out a 2-up grid on a small
    // phone; the cell decides the width here.
    minWidth: 0,
  },
});
