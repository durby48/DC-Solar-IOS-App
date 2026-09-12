import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

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
  updateOpenEntryJob,
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
 * THE JOB PICKER (2026-09-12). It used to appear only when a job was
 * scheduled for today, so a crew member sent to an unscheduled site clocked
 * in against nothing. Now it is always there: today's scheduled jobs first
 * (marked with a calendar glyph), then every other open job — not Complete,
 * not the internal Company job — in a horizontally scrolling row, with "No
 * job" still the first chip. And while ON the clock, a "Working on" control
 * opens the same row and moves the open entry to another job
 * (`updateOpenEntryJob`; RLS lets you edit your own open row only).
 *
 * On a desktop browser the card is drawn COMPACT — it was a phone-sized hero
 * sitting in a 900px-wide column. The phone layout is untouched.
 *
 * It owns its own job fetch rather than taking one as a prop, so it can be
 * dropped onto any screen (and rendered on its own in a preview) without that
 * screen having to know about jobs.
 */

const PUNCH_KEY = 'dcsolar.punch';
const WIDE_BREAKPOINT = 900;

/** `is_internal` is on the row (`select *`) but not on the shared `Job` type yet. */
function isInternal(job: Job): boolean {
  return (job as Job & { is_internal?: boolean | null }).is_internal === true;
}

/** Open for work: not Complete on the pipeline, not the legacy completed status. */
function isOpenJob(job: Job): boolean {
  if (isInternal(job)) return false;
  if (job.stage === 'Complete') return false;
  if (job.stage == null && job.status === 'completed') return false;
  return true;
}

function jobLabel(job: Job): string {
  return job.job_number ?? job.name;
}

export function ClockCard({ style }: { style?: StyleProp<ViewStyle> }) {
  const { width } = useWindowDimensions();
  const compact = Platform.OS === 'web' && width >= WIDE_BREAKPOINT;

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
  /** The "Working on" row, while on the clock. Closed after every choice. */
  const [switching, setSwitching] = useState(false);
  const [switchBusy, setSwitchBusy] = useState(false);

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

  // Jobs feed the picker and the widget. Refetched on focus so a job
  // scheduled from another screen shows up on the way back.
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
        setSwitching(false);
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
          jobLabel: selectedJob ? jobLabel(selectedJob) : null,
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

  /** Move the OPEN server entry to another job (or to none). */
  const switchJob = useCallback(
    async (jobId: string | null) => {
      if (openEntry === null || switchBusy) return;
      if (jobId === openEntry.job_id) {
        setSwitching(false);
        return;
      }
      setSwitchBusy(true);
      try {
        const result = await updateOpenEntryJob(openEntry.id, jobId);
        if (result.ok) {
          setOpenEntry(result.entry);
          setSelectedJobId(result.entry.job_id);
          setSwitching(false);
          haptics.tapMedium();
          const job = jobId ? jobs.find((j) => j.id === jobId) : null;
          setFeedback(job ? `Now working on ${jobLabel(job)} ✓` : 'No job on this punch ✓');
        } else {
          setFeedback(`Could not change the job — ${result.message}`);
        }
      } finally {
        setSwitchBusy(false);
      }
    },
    [openEntry, switchBusy, jobs],
  );

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

  /**
   * The picker's order: today's scheduled jobs, then every other open job,
   * most recently scheduled first (unscheduled ones last). `todayIds` is
   * what marks the first group with the calendar glyph.
   */
  const today = todayISO();
  const { pickerJobs, todayIds } = useMemo(() => {
    const todays = jobs.filter((j) => !isInternal(j) && j.scheduled_for === today);
    const ids = new Set(todays.map((j) => j.id));
    const others = jobs
      .filter((j) => !ids.has(j.id) && isOpenJob(j))
      .sort((a, b) => (b.scheduled_for ?? '').localeCompare(a.scheduled_for ?? ''));
    return { pickerJobs: [...todays, ...others], todayIds: ids };
  }, [jobs, today]);

  const showClockInPicker = sessionEmail !== null && !clockedIn;
  // The switcher needs a SERVER entry to update; an offline-only punch has
  // no row yet, and its job is recorded when it eventually syncs.
  const showSwitcher = openEntry !== null && !punchBusy;
  const workingOn =
    openEntry?.job_id != null ? (jobs.find((j) => j.id === openEntry.job_id) ?? null) : null;

  // Cream on olive while running; ink on the sunrise fill while it isn't.
  const onDark = clockedIn;
  const primary = onDark ? colors.textOnDark : colors.ink;
  const secondary = onDark ? colors.oliveSoft : colors.inkSoft;

  const renderPicker = (selectedId: string | null, onPick: (id: string | null) => void) => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipScroll}
      contentContainerStyle={styles.chipRow}
      keyboardShouldPersistTaps="handled">
      <Chip
        label="No job"
        tone={onDark ? 'sun' : 'olive'}
        selected={selectedId === null}
        disabled={switchBusy}
        onPress={() => onPick(null)}
      />
      {pickerJobs.map((job) => (
        <Chip
          key={job.id}
          label={jobLabel(job)}
          icon={todayIds.has(job.id) ? 'today' : undefined}
          tone={onDark ? 'sun' : 'olive'}
          selected={selectedId === job.id}
          disabled={switchBusy}
          onPress={() => onPick(job.id)}
        />
      ))}
    </ScrollView>
  );

  return (
    <View style={style}>
      <GradientSurface
        gradient={clockedIn ? 'olive' : 'sunrise'}
        radius="lg"
        style={[styles.card, compact && styles.cardCompact, shadows.hero]}>
        <AppText variant="section" color={secondary}>
          {clockedIn ? 'On the clock' : 'Off the clock'}
        </AppText>

        {clockedIn && clockedInSince !== null && !Number.isNaN(clockedInSince) ? (
          <AppText
            variant="numeric"
            color={primary}
            style={[styles.elapsed, compact && styles.elapsedCompact]}>
            {formatElapsed(Math.max(0, now - clockedInSince))}
          </AppText>
        ) : null}

        {showClockInPicker ? renderPicker(selectedJobId, setSelectedJobId) : null}

        {showSwitcher ? (
          <View style={styles.switcher}>
            <AnimatedPressable
              onPress={() => setSwitching((was) => !was)}
              disabled={switchBusy}
              haptic="tapLight"
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={
                workingOn ? `Working on ${jobLabel(workingOn)}. Change job` : 'Choose a job'
              }
              accessibilityState={{ expanded: switching, busy: switchBusy }}
              style={styles.switcherButton}>
              <Ionicons name="briefcase-outline" size={13} color={colors.oliveSoft} />
              <AppText variant="caption" color={colors.textOnDark} numberOfLines={1}>
                {workingOn ? `Working on: ${jobLabel(workingOn)}` : 'No job — choose one'}
              </AppText>
              <Ionicons
                name={switching ? 'chevron-up' : 'chevron-down'}
                size={13}
                color={colors.oliveSoft}
              />
            </AnimatedPressable>
            {switching ? renderPicker(openEntry.job_id, (id) => void switchJob(id)) : null}
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
            style={[
              styles.button,
              compact && styles.buttonCompact,
              clockedIn ? styles.buttonOn : styles.buttonOff,
            ]}>
            <AppText
              variant="button"
              color={clockedIn ? colors.ink : colors.textOnDark}
              style={[styles.buttonText, compact && styles.buttonTextCompact]}>
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
  /** The desktop browser: a status card, not a phone hero. */
  cardCompact: {
    padding: spacing.md,
    gap: spacing.xs + 2,
  },
  elapsed: {
    fontSize: 40,
    lineHeight: 46,
  },
  elapsedCompact: {
    fontSize: 28,
    lineHeight: 32,
  },
  chipScroll: {
    alignSelf: 'stretch',
    // Room for the chips' shadows/edges without clipping the row.
    marginHorizontal: -spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  switcher: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: spacing.sm,
  },
  switcherButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
    borderRadius: radii.pill,
    // A hairline well on olive: see the OLIVE CONTRAST RULES in theme.ts.
    backgroundColor: colors.oliveLine,
    maxWidth: '100%',
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
  buttonCompact: {
    paddingVertical: spacing.sm + 2,
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
  buttonTextCompact: {
    fontSize: 16,
    lineHeight: 20,
  },
});
