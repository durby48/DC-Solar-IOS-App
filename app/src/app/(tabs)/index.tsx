import { useFocusEffect, useRouter } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, useWindowDimensions, View } from 'react-native';

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
  SkeletonList,
  Tile,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { deleteOwnAccount } from '@/lib/account';
import { getSessionEmail } from '@/lib/clock';
import { fetchUnreadCount } from '@/lib/comms';
import { fetchJobs, fetchScheduleEntries } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import { visibleGroups, visibleItems } from '@/lib/hub';
import { type Job } from '@/lib/types';
import { registerPushToken, scheduleJobReminders } from '@/lib/notifications';
import { clearRoleCache, useRoleGate } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Home — the hub the app opens to.
 *
 * This file used to be the Calendar. It is now the front door: greeting and
 * date, the clock card floating over the olive band, today's work, and then
 * every screen in the app grouped into sections that respect what this person
 * is actually allowed to do. The calendar itself moved WHOLE to
 * `(tabs)/calendar.tsx`; the clock moved to `components/ClockCard.tsx` with
 * its widget sync intact. Employee of the Month followed the calendar over on
 * 2026-08-22 — Home is where you punch in, not where you linger.
 *
 * WHY THE ROLE HAS AN EXPLICIT LOADING PHASE. `useRole()` returns `null` both
 * while it is loading AND when you are not staff, so a screen that gates on
 * `role?.isAdmin` renders the VIEWER layout for a moment and then pops the
 * admin sections in. On a hub that is the whole page rearranging itself under
 * your thumb. `useRoleGate()` keeps 'loading' separate and this screen shows
 * skeletons until it knows, so the sections you get are the sections you keep.
 *
 * The section list itself lives in `lib/hub.ts`, shared with the Menu tab.
 */

/** Two columns on a phone, four on a desktop browser. */
const WIDE_BREAKPOINT = 900;

export default function HomeScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const gate = useRoleGate();
  /**
   * ADMIN-ONLY TILES — the Money group (Financials, Sales) and Hours,
   * Employees, Employee of the Month.
   *
   * This is deliberately `ready && isAdmin === true` rather than
   * `gate.role?.isAdmin ?? false`. The two agree today, because the loading
   * phase renders skeletons instead of the grid — but they agree by accident,
   * and the moment somebody rearranges that branch the optimistic form starts
   * rendering a guess. Every state that is not a CONFIRMED admin — still
   * loading, lookup failed, signed out, `role === null` — is not an admin
   * here, and there is no path through this file where an admin tile can be
   * drawn from a maybe. (`lib/hub.ts` gating is a courtesy either way: the
   * destinations check for themselves and RLS decides what any query
   * returns.)
   */
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
   * for every cream page in the app — but Home's olive header runs under the
   * status bar, and dark glyphs on #4D5C2B are close to invisible. Flipping it
   * imperatively on focus (and back on blur) keeps that global default for
   * everyone else: only this screen ever asks for light, and the cleanup runs
   * whether you swipe to Calendar, push into a job, or background the app.
   * `setStatusBarStyle` is a no-op on web, so app.dcsolarkc.com is unaffected.
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
   * register this device's push token. Moved here with the clock card — Home
   * is the screen everyone opens, so it is the reliable place to do it.
   * Both are silent no-ops on web and on denied permission.
   */
  useEffect(() => {
    if (!sessionEmail || jobs.length === 0) return;
    void scheduleJobReminders(jobs);
    void registerPushToken(sessionEmail);
  }, [sessionEmail, jobs]);

  const signOut = async () => {
    try {
      await supabase.auth.signOut();
    } catch {
      // Signed out already, or no session to end — the destination is the
      // same either way.
    }
    clearRoleCache();
    router.replace('/');
  };

  const removeAccount = async () => {
    setBusy(true);
    setDeleteError(null);
    const result = await deleteOwnAccount();
    setBusy(false);
    if (result.ok) {
      clearRoleCache();
      router.replace('/');
    } else {
      setDeleteError(result.message);
    }
  };

  const columns = width >= WIDE_BREAKPOINT ? 4 : 2;
  const groups = visibleGroups(isAdmin);

  return (
    <Screen padded={false} edges={[]} contentContainerStyle={styles.scroll}>
      <HomeHeader />

      <View style={styles.body}>
        {/* The one surface allowed to float. It overlaps the olive band by
            design — see shadows.hero in constants/theme. */}
        <ClockCard style={styles.clock} />

        {/* Employee of the Month used to sit here. It moved to the Calendar
            on 2026-08-22 at Devon's request — Home is the punch-in screen,
            and recognition reads better on the screen you open to look at the
            month. See components/EmployeeOfMonth.tsx. */}

        <FadeInUp index={0}>
          <Card padded={false} style={styles.todayCard}>
            <ListRow
              icon="today"
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

        {gate.phase === 'loading' ? (
          <View style={styles.loading}>
            <SkeletonList count={2} height={96} />
            <SkeletonList count={2} height={96} />
          </View>
        ) : (
          groups.map((group, groupIndex) => (
            <View key={group.key} style={styles.section}>
              <SectionHeader title={group.title} subtitle={group.subtitle} />
              <View style={styles.grid}>
                {visibleItems(isAdmin, group.key).map((item, i) => (
                  <FadeInUp
                    key={item.key}
                    index={groupIndex + i}
                    style={[styles.cell, { width: `${100 / columns}%` }]}>
                    <Tile
                      title={item.title}
                      icon={item.icon}
                      href={item.href}
                      tone={item.tone}
                      badge={item.badge === 'unread' ? unread : undefined}
                      style={styles.tile}
                    />
                  </FadeInUp>
                ))}
              </View>
            </View>
          ))
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
  loading: {
    gap: spacing.md,
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
    // The tile's own `minWidth: 140` would blow out a 2-up grid on a small
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
