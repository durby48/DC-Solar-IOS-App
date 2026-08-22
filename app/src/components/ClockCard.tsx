import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Chip,
  Confetti,
  GradientSurface,
  PulseRing,
} from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  clockIn,
  clockOut,
  fetchOpenEntry,
  fetchTodayCompletedSeconds,
  getSessionEmail,
  type TimeEntry,
} from '@/lib/clock';
import { fetchJobs } from '@/lib/data';
import { formatElapsed, todayISO } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import { type Job } from '@/lib/types';
import { updateWidgetState } from '@/lib/widget';

/**
 * Clocking in and out — the one thing every crew member opens this app to do.
 *
 * Lifted OUT of `(tabs)/index.tsx` when that screen became the Home hub. The
 * punch logic is a straight move and is deliberately unchanged: the
 * AsyncStorage fallback, the server-entry-wins restore, the one-second tick,
 * the offline messages, and the widget sync all behave exactly as they did on
 * the old Today screen. Only the surface around them is new.
 *
 * WHY THE LOCAL FALLBACK EXISTS. Crews work in basements and dead zones. A
 * punch is written to `dcsolar.punch` on the phone FIRST and pushed to
 * Supabase second, so losing signal costs you a sync, never a punch. When a
 * server entry does exist it wins on the next launch, because the office's
 * record is the one that gets paid.
 *
 * It owns its own job fetch rather than taking one as a prop, so it can be
 * dropped onto any screen (and rendered on its own in a preview) without that
 * screen having to know about jobs.
 */

const PUNCH_KEY = 'dcsolar.punch';

export function ClockCard({ style }: { style?: StyleProp<ViewStyle> }) {
  const [clockedInAt, setClockedInAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [punchBusy, setPunchBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  /** One-shot: mounted for a single confetti burst, cleared in `onDone`. */
  const [celebrating, setCelebrating] = useState(false);

  // Restore punch state from storage (local fallback / signed-out mode).
  useEffect(() => {
    AsyncStorage.getItem(PUNCH_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw) as { clockedInAt: number | null };
        if (typeof parsed.clockedInAt === 'number') {
          setClockedInAt(parsed.clockedInAt);
        }
      })
      .catch(() => {});
  }, []);

  // When signed in, the server's open entry is the source of truth.
  useEffect(() => {
    let cancelled = false;
    getSessionEmail().then(async (email) => {
      if (cancelled) return;
      setSessionEmail(email);
      if (!email) return;
      const entry = await fetchOpenEntry(email);
      if (cancelled) return;
      if (entry) {
        setOpenEntry(entry);
        setNow(Date.now());
        // Replace any stale local punch with the server state.
        const startedAt = Date.parse(entry.clock_in);
        setClockedInAt(Number.isNaN(startedAt) ? null : startedAt);
        AsyncStorage.setItem(
          PUNCH_KEY,
          JSON.stringify({ clockedInAt: Number.isNaN(startedAt) ? null : startedAt }),
        ).catch(() => {});
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Today's jobs feed the "which job?" chips and the widget. Refetched on
  // focus so a job scheduled from another screen shows up on the way back.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchJobs().then(({ jobs: fetched }) => {
        if (!cancelled) setJobs(fetched);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const clockedIn = openEntry !== null || clockedInAt !== null;
  const clockedInSince = openEntry !== null ? Date.parse(openEntry.clock_in) : clockedInAt;

  // Tick elapsed time while clocked in.
  useEffect(() => {
    if (!clockedIn) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [clockedIn]);

  // Brief punch feedback, auto-dismissed.
  useEffect(() => {
    if (feedback === null) return;
    const timer = setTimeout(() => setFeedback(null), 5000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const setLocalPunch = useCallback((value: number | null) => {
    setClockedInAt(value);
    AsyncStorage.setItem(PUNCH_KEY, JSON.stringify({ clockedInAt: value })).catch(() => {});
  }, []);

  /**
   * Confetti and a success buzz fire on the way IN and never on the way out:
   * starting the day is the moment worth marking, and a burst every time
   * somebody clocks out at 4pm would wear out inside a week. It fires as soon
   * as the punch is recorded on the phone — the person IS on the clock at that
   * point, whether or not the sync lands.
   */
  const celebrate = useCallback(() => {
    setCelebrating(true);
    haptics.success();
  }, []);

  const handlePunch = useCallback(async () => {
    if (punchBusy) return;

    // Signed-out mode: local-only punch, as before.
    if (!sessionEmail) {
      const next = clockedInAt === null ? Date.now() : null;
      if (next !== null) {
        setNow(Date.now());
        celebrate();
      }
      setLocalPunch(next);
      return;
    }

    setPunchBusy(true);
    try {
      if (openEntry !== null) {
        // Clock out: close the open server entry.
        const result = await clockOut(openEntry);
        setOpenEntry(null);
        setLocalPunch(null);
        setFeedback(
          result.ok
            ? 'Clocked out ✓ synced'
            : 'Clock-out saved on phone — will not sync until you’re online',
        );
      } else if (clockedInAt !== null) {
        // Local punch that never reached the server (offline clock-in).
        setLocalPunch(null);
        setFeedback('Clock-out saved on phone — will not sync until you’re online');
      } else {
        // Clock in: local fallback first, then sync to Supabase.
        const startedAt = Date.now();
        setNow(startedAt);
        setLocalPunch(startedAt);
        celebrate();
        const selectedJob = jobs.find((j) => j.id === selectedJobId) ?? null;
        const result = await clockIn({
          email: sessionEmail,
          jobId: selectedJobId,
          jobLabel: selectedJob ? (selectedJob.job_number ?? selectedJob.name) : null,
        });
        if (result.ok) {
          setOpenEntry(result.entry);
          const serverStart = Date.parse(result.entry.clock_in);
          if (!Number.isNaN(serverStart)) setLocalPunch(serverStart);
          setFeedback('Clocked in ✓ synced');
        } else {
          setFeedback('Saved on phone — will not sync until you’re online');
        }
      }
    } finally {
      setPunchBusy(false);
    }
  }, [punchBusy, sessionEmail, openEntry, clockedInAt, jobs, selectedJobId, setLocalPunch, celebrate]);

  // Keep the home-screen widget in sync: today's job, address, and clock
  // state. Runs whenever jobs load or a punch changes; no-op off iOS.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const todaySeconds = sessionEmail ? await fetchTodayCompletedSeconds(sessionEmail) : 0;
      if (cancelled) return;
      const todayDate = todayISO();
      const punchedJob =
        openEntry?.job_id != null ? jobs.find((j) => j.id === openEntry.job_id) : null;
      const widgetJob = punchedJob ?? jobs.find((j) => j.scheduled_for === todayDate) ?? null;
      const since = openEntry !== null ? Date.parse(openEntry.clock_in) : clockedInAt;
      updateWidgetState({
        jobName: widgetJob?.name ?? '',
        jobNumber: widgetJob?.job_number ?? '',
        address: widgetJob?.address ?? '',
        clockInAt: since !== null && !Number.isNaN(since) ? since : 0,
        todaySeconds,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [jobs, openEntry, clockedInAt, sessionEmail]);

  const today = todayISO();
  const todaysJobs = jobs.filter((j) => j.scheduled_for === today);
  const showJobChips = sessionEmail !== null && !clockedIn && todaysJobs.length > 0;

  // Cream on olive while running; ink on the sunrise fill while it isn't.
  const onDark = clockedIn;
  const primary = onDark ? colors.textOnDark : colors.ink;
  const secondary = onDark ? colors.oliveSoft : colors.inkSoft;

  return (
    <View style={style}>
      <GradientSurface
        gradient={clockedIn ? 'olive' : 'sunrise'}
        radius="lg"
        style={[styles.card, shadows.hero]}>
        <AppText variant="section" color={secondary}>
          {clockedIn ? 'On the clock' : 'Off the clock'}
        </AppText>

        {clockedIn && clockedInSince !== null && !Number.isNaN(clockedInSince) ? (
          <AppText variant="numeric" color={primary} style={styles.elapsed}>
            {formatElapsed(Math.max(0, now - clockedInSince))}
          </AppText>
        ) : null}

        {showJobChips ? (
          <View style={styles.chipRow}>
            <Chip
              label="No job"
              tone="olive"
              selected={selectedJobId === null}
              onPress={() => setSelectedJobId(null)}
            />
            {todaysJobs.map((job) => (
              <Chip
                key={job.id}
                label={job.job_number ?? job.name}
                tone="olive"
                selected={selectedJobId === job.id}
                onPress={() => setSelectedJobId(job.id)}
              />
            ))}
          </View>
        ) : null}

        <View style={styles.buttonWrap}>
          {/* Draws the eye to the one control that ends the shift. Sits
              BEHIND the button, so it never intercepts the tap. */}
          {clockedIn ? <PulseRing color={colors.sun} radius={radii.lg} /> : null}
          <AnimatedPressable
            onPress={handlePunch}
            disabled={punchBusy}
            haptic="tapMedium"
            accessibilityRole="button"
            accessibilityLabel={clockedIn ? 'Clock out' : 'Clock in'}
            accessibilityState={{ disabled: punchBusy, busy: punchBusy }}
            style={[styles.button, clockedIn ? styles.buttonOn : styles.buttonOff]}>
            <AppText
              variant="button"
              color={clockedIn ? colors.ink : colors.textOnDark}
              style={styles.buttonText}>
              {punchBusy ? 'Punching…' : clockedIn ? 'Clock Out' : 'Clock In'}
            </AppText>
          </AnimatedPressable>
        </View>

        <AppText variant="caption" color={secondary} align="center">
          {feedback ??
            (sessionEmail ? 'Syncs to the office' : 'Not signed in — saved on this phone only')}
        </AppText>
      </GradientSurface>

      {/* Outside the gradient, and last, so the shards paint OVER the card and
          are not clipped by its rounded corners the instant they leave it. */}
      {celebrating ? <Confetti onDone={() => setCelebrating(false)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  elapsed: {
    fontSize: 40,
    lineHeight: 46,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
  },
  buttonWrap: {
    alignSelf: 'stretch',
    marginTop: spacing.xs,
  },
  button: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md + 2,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  /** Sun on olive: the one warm thing on a dark card. Ink text, never cream. */
  buttonOn: {
    backgroundColor: colors.sun,
  },
  /** Olive on the sunrise fill — a sun button would vanish into it. */
  buttonOff: {
    backgroundColor: colors.accentPrimary,
  },
  buttonText: {
    fontSize: 20,
    lineHeight: 26,
  },
});
