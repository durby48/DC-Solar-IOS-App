import AsyncStorage from '@react-native-async-storage/async-storage';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { JobCard } from '@/components/JobCard';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  clockIn,
  clockOut,
  fetchOpenEntry,
  fetchTodayCompletedSeconds,
  getSessionEmail,
  type TimeEntry,
} from '@/lib/clock';
import { fetchJobs, fetchScheduleEntries, type ScheduleEntry } from '@/lib/data';
import { formatElapsed, formatFullDate, todayISO } from '@/lib/dates';
import { type Job } from '@/lib/mockData';
import { registerPushToken, scheduleJobReminders } from '@/lib/notifications';
import { formatTimeLabel } from '@/lib/time';
import { updateWidgetState } from '@/lib/widget';

const PUNCH_KEY = 'dcsolar.punch';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** One row of the week list: a day label plus that day's schedule entries. */
interface WeekRow {
  dateISO: string;
  label: string;
  isTomorrow: boolean;
  entries: ScheduleEntry[];
}

/**
 * The rest of the working week, starting tomorrow through Saturday
 * (Mon–Sat week; a Saturday "tomorrow" is Sunday, then the loop stops at
 * the following Saturday so weekends still show what's coming).
 */
function buildWeekRows(entries: ScheduleEntry[]): WeekRow[] {
  const byDate = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    const list = byDate.get(entry.work_date) ?? [];
    list.push(entry);
    byDate.set(entry.work_date, list);
  }
  const rows: WeekRow[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() + i);
    const dow = d.getDay();
    if (i > 1 && dow === 0) break; // ran past Saturday — week over
    const dateISO = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
    rows.push({
      dateISO,
      label: i === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long' }),
      isTomorrow: i === 1,
      entries: byDate.get(dateISO) ?? [],
    });
    if (i > 1 && dow === 6) break; // Saturday included — stop
  }
  return rows;
}

export default function CalendarScreen() {
  const router = useRouter();
  const [clockedInAt, setClockedInAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const [scheduleIsMock, setScheduleIsMock] = useState(false);
  const [sessionEmail, setSessionEmail] = useState<string | null>(null);
  const [openEntry, setOpenEntry] = useState<TimeEntry | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [punchBusy, setPunchBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Restore punch state from storage (local fallback / demo mode).
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

  const clockedIn = openEntry !== null || clockedInAt !== null;
  const clockedInSince =
    openEntry !== null ? Date.parse(openEntry.clock_in) : clockedInAt;

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

  // Refetch the job list on every focus so stage/schedule edits made on
  // other screens show up immediately. Only the jobs list refreshes here —
  // the clock card's state is deliberately left untouched.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchJobs().then(({ jobs: fetched, isMock: mock }) => {
        if (cancelled) return;
        setJobs(fetched);
        setIsMock(mock);
      });
      fetchScheduleEntries().then(({ entries, isMock: mock }) => {
        if (cancelled) return;
        setScheduleEntries(entries);
        setScheduleIsMock(mock);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const setLocalPunch = useCallback((value: number | null) => {
    setClockedInAt(value);
    AsyncStorage.setItem(PUNCH_KEY, JSON.stringify({ clockedInAt: value })).catch(
      () => {},
    );
  }, []);

  const handlePunch = useCallback(async () => {
    if (punchBusy) return;

    // Demo / signed-out mode: local-only punch, as before.
    if (!sessionEmail) {
      const next = clockedInAt === null ? Date.now() : null;
      if (next !== null) setNow(Date.now());
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
  }, [punchBusy, sessionEmail, openEntry, clockedInAt, jobs, selectedJobId, setLocalPunch]);

  // Signed-in devices: keep 24h/1h job reminders synced with the schedule
  // and register this device's push token (both silent no-ops on web/denied
  // permission; reminders are skipped for demo data).
  useEffect(() => {
    if (!sessionEmail || isMock || jobs.length === 0) return;
    scheduleJobReminders(jobs);
    registerPushToken(sessionEmail);
  }, [sessionEmail, isMock, jobs]);

  // Keep the home-screen widget in sync: today's job, address, and clock
  // state. Runs whenever jobs load or a punch changes; no-op off iOS.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const todaySeconds = sessionEmail
        ? await fetchTodayCompletedSeconds(sessionEmail)
        : 0;
      if (cancelled) return;
      const todayDate = todayISO();
      const punchedJob =
        openEntry?.job_id != null ? jobs.find((j) => j.id === openEntry.job_id) : null;
      const widgetJob =
        punchedJob ?? jobs.find((j) => j.scheduled_for === todayDate) ?? null;
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
  // Signed-in with an empty real schedule: the schedule fetch falls back to
  // mock — treat that as "no entries" instead of showing demo rows.
  const realEntries = scheduleIsMock && !isMock ? [] : scheduleEntries;
  const todayEntries = realEntries.filter((e) => e.work_date === today);
  const todaysJobs =
    todayEntries.length > 0
      ? todayEntries
          .map((e) => e.job)
          .filter((job, index, arr) => arr.findIndex((j) => j.id === job.id) === index)
      : jobs.filter((j) => j.scheduled_for === today);
  const weekRows = buildWeekRows(realEntries);

  const showJobChips = sessionEmail !== null && !clockedIn && todaysJobs.length > 0;

  return (
    <SafeAreaView style={styles.safe} edges={['top']}>
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.greeting}>{greeting()}!</Text>
        <Text style={styles.date}>{formatFullDate(new Date())}</Text>

        <View style={styles.clockCard}>
          <Text style={styles.clockLabel}>
            {clockedIn ? 'On the clock' : 'Off the clock'}
          </Text>
          {clockedIn && clockedInSince !== null && !Number.isNaN(clockedInSince) ? (
            <Text style={styles.elapsed}>
              {formatElapsed(Math.max(0, now - clockedInSince))}
            </Text>
          ) : null}
          {showJobChips ? (
            <View style={styles.chipRow}>
              <Pressable
                onPress={() => setSelectedJobId(null)}
                style={[styles.jobChip, selectedJobId === null && styles.jobChipSelected]}>
                <Text
                  style={[
                    styles.jobChipText,
                    selectedJobId === null && styles.jobChipTextSelected,
                  ]}>
                  No job
                </Text>
              </Pressable>
              {todaysJobs.map((job) => (
                <Pressable
                  key={job.id}
                  onPress={() => setSelectedJobId(job.id)}
                  style={[
                    styles.jobChip,
                    selectedJobId === job.id && styles.jobChipSelected,
                  ]}>
                  <Text
                    style={[
                      styles.jobChipText,
                      selectedJobId === job.id && styles.jobChipTextSelected,
                    ]}>
                    {job.job_number ?? job.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          ) : null}
          <Pressable
            onPress={handlePunch}
            disabled={punchBusy}
            style={({ pressed }) => [
              styles.clockButton,
              clockedIn ? styles.clockButtonIn : styles.clockButtonOut,
              (pressed || punchBusy) && styles.pressed,
            ]}>
            <Text
              style={[
                styles.clockButtonText,
                clockedIn ? styles.clockButtonTextIn : styles.clockButtonTextOut,
              ]}>
              {punchBusy ? 'Punching…' : clockedIn ? 'Clock Out' : 'Clock In'}
            </Text>
          </Pressable>
          <Text style={styles.syncNote}>
            {feedback ??
              (sessionEmail ? 'Syncs to the office' : 'Demo mode — saves to this phone only')}
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Today&apos;s jobs</Text>
        {todaysJobs.length > 0 ? (
          <View style={styles.jobList}>
            {todaysJobs.map((job) => (
              <JobCard key={job.id} job={job} subtitle="Today" />
            ))}
          </View>
        ) : (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyText}>No jobs scheduled for today.</Text>
          </View>
        )}

        <Text style={styles.sectionTitle}>This week</Text>
        <View style={styles.weekCard}>
          {weekRows.map((row, index) => (
            <View
              key={row.dateISO}
              style={[styles.weekRow, index > 0 && styles.weekRowBorder]}>
              <Text style={styles.weekDay}>{row.label}</Text>
              <View style={styles.weekJobs}>
                {row.entries.length > 0 ? (
                  row.entries.map((entry) => {
                    const time = formatTimeLabel(entry.start_time);
                    return (
                      <Pressable
                        key={entry.id}
                        onPress={() =>
                          router.push({ pathname: '/job/[id]', params: { id: entry.job.id } })
                        }
                        style={({ pressed }) => pressed && styles.pressed}>
                        <Text style={styles.weekJobText} numberOfLines={2}>
                          {entry.job.name}
                          {entry.job.address ? ` — ${entry.job.address}` : ''}
                          {time ? ` · ${time}` : ''}
                        </Text>
                      </Pressable>
                    );
                  })
                ) : row.isTomorrow ? (
                  <Text style={styles.weekEmptyText}>No work for tomorrow</Text>
                ) : null}
              </View>
            </View>
          ))}
        </View>

        {isMock ? <Text style={styles.mockNote}>Showing demo data</Text> : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    gap: spacing.sm,
    paddingBottom: spacing.xl,
  },
  greeting: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: '800',
  },
  date: {
    color: colors.inkSoft,
    fontSize: 16,
    marginBottom: spacing.sm,
  },
  clockCard: {
    backgroundColor: colors.white,
    borderRadius: radii.lg,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.md,
    ...shadows.card,
  },
  clockLabel: {
    color: colors.inkSoft,
    fontSize: 15,
    fontWeight: '600',
  },
  elapsed: {
    color: colors.ink,
    fontSize: 40,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.sm,
    alignSelf: 'stretch',
  },
  jobChip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  jobChipSelected: {
    backgroundColor: colors.skySoft,
    borderColor: colors.skySoft,
  },
  jobChipText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  jobChipTextSelected: {
    color: colors.ocean,
    fontWeight: '800',
  },
  clockButton: {
    borderRadius: radii.lg,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    alignSelf: 'stretch',
    ...shadows.card,
  },
  clockButtonOut: {
    backgroundColor: colors.sun,
  },
  clockButtonIn: {
    backgroundColor: colors.ink,
  },
  clockButtonText: {
    fontSize: 22,
    fontWeight: '800',
  },
  clockButtonTextOut: {
    color: colors.ink,
  },
  clockButtonTextIn: {
    color: colors.cream,
  },
  pressed: {
    opacity: 0.85,
  },
  syncNote: {
    color: colors.inkSoft,
    fontSize: 12,
    textAlign: 'center',
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.md,
  },
  jobList: {
    gap: spacing.md,
  },
  weekCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    ...shadows.card,
  },
  weekRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  weekRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  weekDay: {
    width: 92,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  weekJobs: {
    flex: 1,
    gap: spacing.xs,
    minHeight: 18,
  },
  weekJobText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '600',
  },
  weekEmptyText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  emptyCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  emptyText: {
    color: colors.inkSoft,
    fontSize: 14,
  },
  mockNote: {
    color: colors.inkSoft,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.md,
  },
});
