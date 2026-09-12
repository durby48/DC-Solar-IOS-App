import { useFocusEffect, useNavigation, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
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
import { HomeHeader } from '@/components/HomeHeader';
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
import { deleteOwnAccount } from '@/lib/account';
import { explainAdminOnly, isLockedFor } from '@/lib/adminGate';
import { getSessionEmail } from '@/lib/clock';
import { fetchUnreadCount } from '@/lib/comms';
import { fetchJobs, fetchScheduleEntries } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import { HUBS } from '@/lib/hub';
import { type Job } from '@/lib/types';
import { registerPushToken, scheduleJobReminders } from '@/lib/notifications';
import { registerForIncomingCalls } from '@/lib/voice';
import { clearRoleCache, useRoleGate } from '@/lib/role';
import { resetToLogin, signOutAndLeave } from '@/lib/signOut';

/**
 * Home — the hub the app opens to.
 *
 * The olive band with the greeting, the clock card floating over its lower
 * edge, today's work, and then the FIVE HUBS (2026-09-12 overhaul): CRM,
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
 */

/** Two columns on a phone, five (one per hub) on a desktop browser. */
const WIDE_BREAKPOINT = 900;

export default function HomeScreen() {
  const router = useRouter();
  const navigation = useNavigation();
  const { width } = useWindowDimensions();
  const gate = useRoleGate();
  const isAdmin = gate.phase === 'ready' && gate.role?.isAdmin === true;

  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [todayCount, setTodayCount] = useState<number | null>(null);
  const [unread, setUnread] = useState(0);

  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getSessionEmail().then((email) => {
      if (!cancelled) setSessionEmail(email);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Light status-bar glyphs while Home is on screen.
   *
   * The root layout sets `<StatusBar style="dark" />` globally, which is right
   * for every light page in the app — but Home's olive header runs under the
   * status bar, and dark glyphs on #4D5C2B are close to invisible. Flipping it
   * imperatively on focus (and back on blur) keeps that global default for
   * everyone else. `setStatusBarStyle` is a no-op on web.
   */
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('light');
      return () => setStatusBarStyle('dark');
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
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
    }, []),
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
    if (!sessionEmail || !isAdmin) return;
    void registerForIncomingCalls();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void registerForIncomingCalls();
    });
    return () => sub.remove();
  }, [sessionEmail, isAdmin]);

  // Shared helper: ends the session (with a timeout) and resets the ROOT
  // stack to the login route. `router.replace('/')` from inside the tabs
  // resolves to the Home tab, which is why the old button looked dead.
  const signOut = () => signOutAndLeave(navigation);

  const removeAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    const result = await deleteOwnAccount();
    setBusy(false);
    if (result.ok) {
      clearRoleCache();
      resetToLogin(navigation);
    } else {
      setDeleteError(result.message);
    }
  };

  const wide = width >= WIDE_BREAKPOINT;
  // One row of five on a desktop browser; two columns on a phone.
  const columns = wide ? HUBS.length : 2;
  const compact = Platform.OS === 'web' && wide;

  return (
    <Screen padded={false} edges={[]} contentContainerStyle={styles.scroll}>
      <HomeHeader />

      <View style={[styles.body, compact && styles.bodyCompact]}>
        {/* The one surface allowed to float. It overlaps the olive band by
            design — see shadows.hero in constants/theme. */}
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
        {deleting ? (
          <Card tone="danger" style={styles.dangerCard}>
            <AppText variant="heading" color={colors.danger}>
              Delete your account?
            </AppText>
            <AppText variant="body" color={colors.textSecondary}>
              This permanently removes your login and signs you out everywhere. It does not remove
              your employment record, or the jobs and hours you&apos;ve logged — the office keeps
              those. Ask Devon if you need those changed.
            </AppText>
            {deleteError ? (
              <AppText variant="bodyStrong" color={colors.danger}>
                {deleteError}
              </AppText>
            ) : null}
            <View style={styles.dangerRow}>
              <Button
                label="Cancel"
                variant="ghost"
                size="sm"
                disabled={busy}
                onPress={() => setDeleting(false)}
              />
              {busy ? (
                <ActivityIndicator color={colors.danger} />
              ) : (
                <Button
                  label="Delete permanently"
                  variant="danger"
                  size="sm"
                  onPress={removeAccount}
                />
              )}
            </View>
          </Card>
        ) : (
          <AnimatedPressable
            onPress={() => setDeleting(true)}
            hitSlop={8}
            accessibilityRole="button"
            style={styles.deleteLinkWrap}>
            <AppText variant="caption" color={colors.danger}>
              Delete my account
            </AppText>
          </AnimatedPressable>
        )}

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
  /**
   * Pulls the clock card up over the header band. The band's own
   * `paddingBottom: xxl` is what leaves olive showing above and beside it.
   */
  clock: {
    marginTop: -spacing.xl,
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
  dangerCard: {
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.md,
  },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  deleteLinkWrap: {
    alignSelf: 'center',
    paddingVertical: spacing.sm,
  },
});
