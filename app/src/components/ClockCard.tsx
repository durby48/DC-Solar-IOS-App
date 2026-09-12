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

import { AnimatedPressable, AppText, Chip, Confetti, PulseRing } from '@/components/ui';
import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import {
  clockIn,
  clockOut,
  fetchOpenEntry,
  fetchTodayCompletedSeconds,
  getSessionEmail,
  updateOpenEntryJob,
  type TimeEntry,
} from '@/lib/clock';
import { fetchJobs, fetchScheduleEntries, type ScheduleEntry } from '@/lib/data';
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
 * THE JOB PICKER (2026-09-13). Devon: "limit the options to 'company office'
 * or currently scheduled jobs for that day. Don't display every single
 * option." So the row is exactly TODAY'S jobs, then one "Company office"
 * chip — nothing else. "Today" is sourced the way the calendar decides it:
 * every job with a `job_schedule_dates` row for today (a two-day install is
 * on both days), plus any job whose single `scheduled_for` is today. The
 * office chip is the `is_internal` container job (DC-26026), resolved from the
 * fetched rows at runtime the way `financials.tsx` does — never a hard-coded
 * id. If that row is not there (a signed-out browser RLS answers with
 * nothing) a "No job" chip stands in so the crew can still punch in.
 *
 * Default selection: the first scheduled job, else the office. The selection
 * is DERIVED from state rather than pushed into it by an effect, so a job
 * that appears after the fetch lands is picked up without a re-sync.
 *
 * While ON the clock, a "Working on" control opens the same limited row and
 * moves the open entry to another job (`updateOpenEntryJob`; RLS lets you
 * edit your own open row only).
 *
 * COLOURS (2026-09-12, "Sonoran dusk"): off the clock it is the charcoal card
 * with a pipeline-sky edge; on the clock it sits on the HR hub's solid green
 * ground with white text. In BOTH states the punch button is the desert-tan
 * action pill with dark `textOnAction` text — the one control on Home that
 * has to be found in sunlight, so it takes the palette's highest-contrast
 * pairing (8.4:1) rather than a pastel fill.
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

/** The company container (DC-26026 today) — resolved by flag, never by id. */
function isInternal(job: Job): boolean {
  return job.is_internal === true;
}

function jobLabel(job: Job): string {
  return job.job_number ?? job.name;
}

/** "Company office" for the internal job, the job number for the rest. */
function chipLabel(job: Job): string {
  return isInternal(job) ? 'Company office' : jobLabel(job);
}

/** Sentinel for the "No job" chip, used only when there is no office job. */
const NO_JOB = null;

export function ClockCard({ style }: { style?: StyleProp<ViewStyle> }) {
  const { width } = useWindowDimensions();
  const compact = Platform.OS === 'web' && width >= WIDE_BREAKPOINT;

  const [clockedInAt, setClockedInAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [todayEntries, setTodayEntries] = useState<ScheduleEntry[]>([]);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  /**
   * What the person tapped. `undefined` = nothing yet, so the default
   * (first scheduled job, else the office) applies. Only ever holds an id
   * from the picker's own set — see `selectedJobId` below.
   */
  const [pickedJobId, setPickedJobId] = useState<string | null | undefined>(undefined);
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

  // Jobs feed the picker and the widget; the schedule says which of them are
  // today's. Both refetched on focus so a job scheduled from another screen
  // shows up on the way back.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchJobs().then(({ jobs: fetched }) => {
        if (!cancelled) setJobs(fetched);
      });
      fetchScheduleEntries().then(({ entries }) => {
        if (cancelled) return;
        const today = todayISO();
        setTodayEntries(entries.filter((e) => e.work_date === today));
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

  /**
   * The picker's set: today's scheduled jobs (calendar order — schedule rows
   * first, then the legacy single-date jobs), followed by the office job.
   * `officeJob` is null when the internal row is not in the fetch.
   */
  const today = todayISO();
  const { todayJobs, officeJob } = useMemo(() => {
    const seen = new Set<string>();
    const todays: Job[] = [];
    for (const entry of todayEntries) {
      const job = entry.job;
      if (isInternal(job) || seen.has(job.id)) continue;
      seen.add(job.id);
      todays.push(job);
    }
    for (const job of jobs) {
      if (isInternal(job) || seen.has(job.id) || job.scheduled_for !== today) continue;
      seen.add(job.id);
      todays.push(job);
    }
    return { todayJobs: todays, officeJob: jobs.find(isInternal) ?? null };
  }, [jobs, todayEntries, today]);

  /** Every id the picker offers; `null` only when "No job" is standing in. */
  const pickerIds = useMemo(() => {
    const ids: (string | null)[] = todayJobs.map((j) => j.id);
    ids.push(officeJob ? officeJob.id : NO_JOB);
    return ids;
  }, [todayJobs, officeJob]);

  const defaultJobId: string | null = todayJobs[0]?.id ?? officeJob?.id ?? NO_JOB;
  // A stale pick (the job was taken off today's schedule) falls back to the
  // default rather than clocking in against something not on the row.
  const selectedJobId: string | null =
    pickedJobId !== undefined && pickerIds.includes(pickedJobId) ? pickedJobId : defaultJobId;

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
          setPickedJobId(result.entry.job_id);
          setSwitching(false);
          haptics.tapMedium();
          const job = jobId ? jobs.find((j) => j.id === jobId) : null;
          setFeedback(job ? `Now working on ${chipLabel(job)} ✓` : 'No job on this punch ✓');
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
      const punchedJob =
        openEntry?.job_id != null ? jobs.find((j) => j.id === openEntry.job_id) : null;
      const widgetJob = punchedJob ?? todayJobs[0] ?? null;
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
  }, [jobs, todayJobs, openEntry, clockedInAt, sessionEmail]);

  const showClockInPicker = sessionEmail !== null && !clockedIn;
  // The switcher needs a SERVER entry to update; an offline-only punch has
  // no row yet, and its job is recorded when it eventually syncs.
  const showSwitcher = openEntry !== null && !punchBusy;
  // Looked up in ALL jobs, not the picker's set: a punch started against a
  // job that has since left today's schedule still says what it is on.
  const workingOn =
    openEntry?.job_id != null ? (jobs.find((j) => j.id === openEntry.job_id) ?? null) : null;

  // White on the green ground while running; ink on the white card while not.
  const onDark = clockedIn;
  const primary = onDark ? colors.textOnDark : colors.ink;
  const secondary = onDark ? 'rgba(255,255,255,0.78)' : colors.inkSoft;

  const renderPicker = (selectedId: string | null, onPick: (id: string | null) => void) => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.chipScroll}
      contentContainerStyle={styles.chipRow}
      keyboardShouldPersistTaps="handled">
      {todayJobs.map((job) => (
        <Chip
          key={job.id}
          label={jobLabel(job)}
          icon="today"
          tone="neutral"
          selected={selectedId === job.id}
          disabled={switchBusy}
          onPress={() => onPick(job.id)}
          style={selectedId === job.id && !onDark ? styles.chipSelectedBlue : undefined}
        />
      ))}
      {officeJob ? (
        <Chip
          label="Company office"
          icon="business"
          tone="neutral"
          selected={selectedId === officeJob.id}
          disabled={switchBusy}
          onPress={() => onPick(officeJob.id)}
          style={selectedId === officeJob.id && !onDark ? styles.chipSelectedBlue : undefined}
        />
      ) : (
        <Chip
          label="No job"
          tone="neutral"
          selected={selectedId === NO_JOB}
          disabled={switchBusy}
          onPress={() => onPick(NO_JOB)}
          style={selectedId === NO_JOB && !onDark ? styles.chipSelectedBlue : undefined}
        />
      )}
    </ScrollView>
  );

  return (
    <View style={style}>
      <View
        style={[
          styles.card,
          compact && styles.cardCompact,
          clockedIn ? styles.cardOn : styles.cardOff,
          shadows.card,
        ]}>
        <AppText variant="section" color={onDark ? secondary : hubColors.pipeline.fg}>
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

        {showClockInPicker ? renderPicker(selectedJobId, setPickedJobId) : null}

        {showSwitcher ? (
          <View style={styles.switcher}>
            <AnimatedPressable
              onPress={() => setSwitching((was) => !was)}
              disabled={switchBusy}
              haptic="tapLight"
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={
                workingOn ? `Working on ${chipLabel(workingOn)}. Change job` : 'Choose a job'
              }
              accessibilityState={{ expanded: switching, busy: switchBusy }}
              style={styles.switcherButton}>
              <Ionicons name="briefcase-outline" size={13} color={secondary} />
              <AppText variant="caption" color={colors.textOnDark} numberOfLines={1}>
                {workingOn ? `Working on: ${chipLabel(workingOn)}` : 'No job — choose one'}
              </AppText>
              <Ionicons
                name={switching ? 'chevron-up' : 'chevron-down'}
                size={13}
                color={secondary}
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
            style={[styles.button, compact && styles.buttonCompact]}>
            <AppText
              variant="button"
              color={colors.textOnAction}
              style={[styles.buttonText, compact && styles.buttonTextCompact]}>
              {punchBusy ? 'Punching…' : clockedIn ? 'Clock Out' : 'Clock In'}
            </AppText>
          </AnimatedPressable>
        </View>

        <AppText variant="caption" color={secondary} align="center">
          {feedback ??
            (sessionEmail ? 'Syncs to the office' : 'Not signed in — saved on this phone only')}
        </AppText>
      </View>

      {/* Outside the card, and last, so the shards paint OVER the card and
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
    borderRadius: radii.lg,
    borderWidth: 1.5,
    overflow: 'hidden',
  },
  /** The desktop browser: a status card, not a phone hero. */
  cardCompact: {
    padding: spacing.md,
    gap: spacing.xs + 2,
  },
  /** Off the clock: the charcoal card, with the Pipeline hub's sky edge. */
  cardOff: {
    backgroundColor: colors.surface,
    borderColor: hubColors.pipeline.fg,
  },
  /** On the clock: the HR hub's solid green ground, white text. */
  cardOn: {
    backgroundColor: hubColors.hr.ground,
    borderColor: hubColors.hr.ground,
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
  /**
   * The selected chip on the charcoal card takes the pipeline sky rather than
   * the neutral tone's pale ink; the chip's dark "on" text suits both. On the
   * green card the ink fill stays — sky on green reads as mud.
   */
  chipSelectedBlue: {
    backgroundColor: hubColors.pipeline.fg,
    borderColor: hubColors.pipeline.fg,
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
    // A translucent white well on the green ground.
    backgroundColor: 'rgba(255,255,255,0.16)',
    maxWidth: '100%',
  },
  buttonWrap: {
    alignSelf: 'stretch',
    marginTop: spacing.xs,
  },
  /** The tan action pill, in both states; its text is `textOnAction`. */
  button: {
    borderRadius: radii.lg,
    paddingVertical: spacing.md + 2,
    alignItems: 'center',
    alignSelf: 'stretch',
    borderWidth: 2,
    backgroundColor: colors.sun,
    borderColor: colors.sun,
  },
  buttonCompact: {
    paddingVertical: spacing.sm + 2,
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
