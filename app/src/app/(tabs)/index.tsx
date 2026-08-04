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
import { fetchAssignmentsByJob, type Assignment } from '@/lib/assignments';
import {
  fetchJobs,
  fetchScheduleEntries,
  fetchScheduleRange,
  type ScheduleEntry,
} from '@/lib/data';
import { formatElapsed, formatFullDate, todayISO } from '@/lib/dates';
import { type Job } from '@/lib/mockData';
import { registerPushToken, scheduleJobReminders } from '@/lib/notifications';
import { useRole } from '@/lib/role';
import { formatTimeLabel } from '@/lib/time';
import { updateWidgetState } from '@/lib/widget';

const PUNCH_KEY = 'dcsolar.punch';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** One cell of the month grid. */
interface GridDay {
  dateISO: string;
  dayNum: number;
  inMonth: boolean;
}

/**
 * Sunday-start month grid (like Google/Apple Calendar): full weeks covering
 * the given month, padded with the neighbors' trailing/leading days.
 */
function buildMonthGrid(year: number, month: number): GridDay[][] {
  const first = new Date(year, month, 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay()); // back to Sunday
  const weeks: GridDay[][] = [];
  const cursor = new Date(start);
  do {
    const week: GridDay[] = [];
    for (let i = 0; i < 7; i++) {
      week.push({
        dateISO: `${cursor.getFullYear()}-${`${cursor.getMonth() + 1}`.padStart(2, '0')}-${`${cursor.getDate()}`.padStart(2, '0')}`,
        dayNum: cursor.getDate(),
        inMonth: cursor.getMonth() === month,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  } while (cursor.getMonth() === month);
  return weeks;
}

function isoOf(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;
}

/**
 * Monday of the week containing today, shifted by `offset` weeks.
 * Sunday counts as belonging to the week that just ENDED — the crew never
 * works Sunday, so on a Sunday you want to still be looking at Mon–Sat.
 */
function mondayOf(offset: number): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  const dow = d.getDay(); // 0 = Sun … 6 = Sat
  const toMonday = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + toMonday + offset * 7);
  return d;
}

/** One row of the week list: a day plus that day's schedule entries. */
interface WeekRow {
  dateISO: string;
  /** "Mon" — short weekday. */
  weekday: string;
  /** "8/3" — the actual date, so a week is never ambiguous. */
  dayLabel: string;
  isToday: boolean;
  isTomorrow: boolean;
  entries: ScheduleEntry[];
}

/**
 * Monday→Saturday rows for the week at `offset`. Sundays are omitted
 * entirely (nobody works Sunday), so this is always exactly 6 rows.
 */
function buildWeekRows(entries: ScheduleEntry[], offset: number): WeekRow[] {
  const byDate = new Map<string, ScheduleEntry[]>();
  for (const entry of entries) {
    const list = byDate.get(entry.work_date) ?? [];
    list.push(entry);
    byDate.set(entry.work_date, list);
  }
  const today = todayISO();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = isoOf(tomorrowDate);

  const monday = mondayOf(offset);
  const rows: WeekRow[] = [];
  for (let i = 0; i < 6; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateISO = isoOf(d);
    rows.push({
      dateISO,
      weekday: d.toLocaleDateString('en-US', { weekday: 'short' }),
      dayLabel: `${d.getMonth() + 1}/${d.getDate()}`,
      isToday: dateISO === today,
      isTomorrow: dateISO === tomorrow,
      entries: byDate.get(dateISO) ?? [],
    });
  }
  return rows;
}

/** "Aug 3 – Aug 8" for the Mon–Sat span at `offset`. */
function weekRangeLabel(offset: number): string {
  const monday = mondayOf(offset);
  const saturday = new Date(monday);
  saturday.setDate(monday.getDate() + 5);
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(monday)} – ${fmt(saturday)}`;
}

/** "This week" / "Last week" / "Next week" / "Week of …". */
function weekTitle(offset: number): string {
  if (offset === 0) return 'This week';
  if (offset === -1) return 'Last week';
  if (offset === 1) return 'Next week';
  return offset < 0 ? `${Math.abs(offset)} weeks ago` : `In ${offset} weeks`;
}

export default function CalendarScreen() {
  const router = useRouter();
  const role = useRole();
  const [clockedInAt, setClockedInAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isMock, setIsMock] = useState(false);
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
  const [scheduleIsMock, setScheduleIsMock] = useState(false);
  // Crew assignments per job (names shown on every calendar entry).
  const [assignments, setAssignments] = useState<Map<string, Assignment[]> | null>(null);
  // Admin view toggle + month navigation (0 = current month).
  const [viewMode, setViewMode] = useState<'week' | 'month'>('week');
  const [monthOffset, setMonthOffset] = useState(0);
  // Week pager (0 = current Mon–Sat week; negative = past weeks).
  const [weekOffset, setWeekOffset] = useState(0);
  const [weekEntries, setWeekEntries] = useState<ScheduleEntry[] | null>(null);
  const [monthEntries, setMonthEntries] = useState<ScheduleEntry[]>([]);
  const [monthLoading, setMonthLoading] = useState(false);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
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
      fetchAssignmentsByJob().then((map) => {
        if (!cancelled) setAssignments(map);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  // Month view data: the whole visible GRID range (padded weeks include a
  // few days of the neighbor months, so fetch those too).
  useEffect(() => {
    if (viewMode !== 'month') return;
    let cancelled = false;
    const base = new Date();
    const year = base.getFullYear();
    const month = base.getMonth() + monthOffset;
    const grid = buildMonthGrid(year, month);
    const from = grid[0][0].dateISO;
    const to = grid[grid.length - 1][6].dateISO;
    setMonthLoading(true);
    fetchScheduleRange(from, to).then((entries) => {
      if (cancelled) return;
      setMonthEntries(entries);
      setMonthLoading(false);
    });
    // Default the selected day to today when it's inside this month.
    const todayStr = todayISO();
    setSelectedDay(grid.some((w) => w.some((d) => d.dateISO === todayStr && d.inMonth)) ? todayStr : null);
    return () => {
      cancelled = true;
    };
  }, [viewMode, monthOffset]);

  // Week view data. The default schedule fetch only reaches 7 days back, so
  // paging into older weeks needs its own range query.
  useEffect(() => {
    let cancelled = false;
    const monday = mondayOf(weekOffset);
    const saturday = new Date(monday);
    saturday.setDate(monday.getDate() + 5);
    fetchScheduleRange(isoOf(monday), isoOf(saturday)).then((entries) => {
      if (!cancelled) setWeekEntries(entries);
    });
    return () => {
      cancelled = true;
    };
  }, [weekOffset, scheduleEntries]);

  /** "Devon, Isaiah" — first names of the crew assigned to a job. */
  const crewLine = useCallback(
    (jobId: string): string | null => {
      const crew = assignments?.get(jobId);
      if (!crew || crew.length === 0) return null;
      return crew.map((a) => a.name.split(' ')[0]).join(', ');
    },
    [assignments],
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
  // Signed-in devices use the week range query; demo/mock mode falls back to
  // the bundled entries so the signed-out preview still shows something.
  const weekSource = scheduleIsMock ? realEntries : (weekEntries ?? realEntries);
  const weekRows = buildWeekRows(weekSource, weekOffset);

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

        {role?.isAdmin ? (
          <View style={styles.viewToggleRow}>
            {(['week', 'month'] as const).map((mode) => {
              const active = viewMode === mode;
              return (
                <Pressable
                  key={mode}
                  onPress={() => setViewMode(mode)}
                  style={[styles.viewToggleChip, active && styles.viewToggleChipActive]}>
                  <Text
                    style={[
                      styles.viewToggleText,
                      active && styles.viewToggleTextActive,
                    ]}>
                    {mode === 'week' ? 'Week' : 'Month'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {viewMode === 'month' && role?.isAdmin ? (
          <>
            <View style={styles.monthNav}>
              <Pressable
                onPress={() => setMonthOffset((n) => n - 1)}
                hitSlop={8}
                style={({ pressed }) => [styles.monthArrow, pressed && styles.pressed]}>
                <Text style={styles.monthArrowText}>‹</Text>
              </Pressable>
              <Text style={styles.monthTitle}>
                {new Date(
                  new Date().getFullYear(),
                  new Date().getMonth() + monthOffset,
                  1,
                ).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
              </Text>
              <Pressable
                onPress={() => setMonthOffset((n) => n + 1)}
                hitSlop={8}
                style={({ pressed }) => [styles.monthArrow, pressed && styles.pressed]}>
                <Text style={styles.monthArrowText}>›</Text>
              </Pressable>
            </View>
            {(() => {
              const base = new Date();
              const grid = buildMonthGrid(base.getFullYear(), base.getMonth() + monthOffset);
              const entriesFor = (day: string) => monthEntries.filter((e) => e.work_date === day);
              const selectedEntries = selectedDay ? entriesFor(selectedDay) : [];
              return (
                <>
                  <View style={styles.gridCard}>
                    <View style={styles.gridHeaderRow}>
                      {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                        <Text key={`${d}${i}`} style={styles.gridHeaderText}>
                          {d}
                        </Text>
                      ))}
                    </View>
                    {grid.map((week, wi) => (
                      <View key={wi} style={styles.gridWeekRow}>
                        {week.map((day) => {
                          const dayEntries = entriesFor(day.dateISO);
                          const isToday = day.dateISO === today;
                          const isSelected = day.dateISO === selectedDay;
                          return (
                            <Pressable
                              key={day.dateISO}
                              onPress={() => setSelectedDay(day.dateISO)}
                              style={[
                                styles.gridCell,
                                isSelected && styles.gridCellSelected,
                              ]}>
                              <View
                                style={[
                                  styles.gridDayNumWrap,
                                  isToday && styles.gridDayNumToday,
                                ]}>
                                <Text
                                  style={[
                                    styles.gridDayNum,
                                    !day.inMonth && styles.gridDayNumOutside,
                                    isToday && styles.gridDayNumTodayText,
                                  ]}>
                                  {day.dayNum}
                                </Text>
                              </View>
                              {/* Chips route straight to the job, matching the
                                  week view; tapping elsewhere in the cell still
                                  just selects the day. */}
                              {dayEntries.slice(0, 2).map((entry) => (
                                <Pressable
                                  key={entry.id}
                                  onPress={() =>
                                    router.push({
                                      pathname: '/job/[id]',
                                      params: { id: entry.job.id },
                                    })
                                  }
                                  hitSlop={2}
                                  style={({ pressed }) => [
                                    styles.gridChip,
                                    pressed && styles.pressed,
                                  ]}>
                                  <Text style={styles.gridChipText} numberOfLines={1}>
                                    {entry.job.job_number ?? entry.job.name}
                                  </Text>
                                </Pressable>
                              ))}
                              {dayEntries.length > 2 ? (
                                <Text style={styles.gridMore}>+{dayEntries.length - 2}</Text>
                              ) : null}
                            </Pressable>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                  {monthLoading ? (
                    <View style={styles.emptyCard}>
                      <Text style={styles.emptyText}>Loading…</Text>
                    </View>
                  ) : selectedDay ? (
                    <>
                      <Text style={styles.sectionTitle}>
                        {selectedDay === today
                          ? 'Today'
                          : new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-US', {
                              weekday: 'long',
                              month: 'long',
                              day: 'numeric',
                            })}
                      </Text>
                      {selectedEntries.length === 0 ? (
                        <View style={styles.emptyCard}>
                          <Text style={styles.emptyText}>Nothing scheduled.</Text>
                        </View>
                      ) : (
                        <View style={styles.weekCard}>
                          {selectedEntries.map((entry, index) => {
                            const time = formatTimeLabel(entry.start_time);
                            const crew = crewLine(entry.job.id);
                            return (
                              <Pressable
                                key={entry.id}
                                onPress={() =>
                                  router.push({
                                    pathname: '/job/[id]',
                                    params: { id: entry.job.id },
                                  })
                                }
                                style={({ pressed }) => [
                                  styles.weekRow,
                                  index > 0 && styles.weekRowBorder,
                                  pressed && styles.pressed,
                                ]}>
                                <View style={styles.weekJobs}>
                                  <Text style={styles.weekJobText} numberOfLines={2}>
                                    {entry.job.name}
                                    {entry.job.address ? ` — ${entry.job.address}` : ''}
                                    {time ? ` · ${time}` : ''}
                                  </Text>
                                  {crew ? <Text style={styles.crewText}>{crew}</Text> : null}
                                </View>
                              </Pressable>
                            );
                          })}
                        </View>
                      )}
                    </>
                  ) : (
                    <View style={styles.emptyCard}>
                      <Text style={styles.emptyText}>Tap a day to see its jobs.</Text>
                    </View>
                  )}
                </>
              );
            })()}
          </>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Today&apos;s jobs</Text>
            {todaysJobs.length > 0 ? (
              <View style={styles.jobList}>
                {todaysJobs.map((job) => (
                  <View key={job.id}>
                    <JobCard job={job} subtitle="Today" />
                    {crewLine(job.id) ? (
                      <Text style={styles.crewUnderCard}>Crew: {crewLine(job.id)}</Text>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : (
              <View style={styles.emptyCard}>
                <Text style={styles.emptyText}>No jobs scheduled for today.</Text>
              </View>
            )}

            <View style={styles.weekHeaderRow}>
              <Pressable
                onPress={() => setWeekOffset((n) => n - 1)}
                hitSlop={8}
                style={({ pressed }) => [styles.weekArrow, pressed && styles.pressed]}>
                <Text style={styles.weekArrowText}>‹</Text>
              </Pressable>
              <View style={styles.weekHeaderLabel}>
                <Text style={styles.sectionTitleTight}>{weekTitle(weekOffset)}</Text>
                <Text style={styles.weekRangeText}>{weekRangeLabel(weekOffset)}</Text>
              </View>
              <Pressable
                onPress={() => setWeekOffset((n) => n + 1)}
                hitSlop={8}
                style={({ pressed }) => [styles.weekArrow, pressed && styles.pressed]}>
                <Text style={styles.weekArrowText}>›</Text>
              </Pressable>
            </View>
            {weekOffset !== 0 ? (
              <Pressable
                onPress={() => setWeekOffset(0)}
                style={({ pressed }) => [styles.backToWeek, pressed && styles.pressed]}>
                <Text style={styles.backToWeekText}>Back to this week</Text>
              </Pressable>
            ) : null}
            <View style={styles.weekCard}>
              {weekRows.map((row, index) => (
                <View
                  key={row.dateISO}
                  style={[
                    styles.weekRow,
                    index > 0 && styles.weekRowBorder,
                    row.isToday && styles.weekRowToday,
                  ]}>
                  <View style={styles.weekDayCol}>
                    <Text style={[styles.weekDay, row.isToday && styles.weekDayToday]}>
                      {row.weekday} {row.dayLabel}
                    </Text>
                    {row.isToday ? (
                      <Text style={styles.weekDayBadge}>Today</Text>
                    ) : row.isTomorrow ? (
                      <Text style={styles.weekDayBadgeSoft}>Tomorrow</Text>
                    ) : null}
                  </View>
                  <View style={styles.weekJobs}>
                    {row.entries.length > 0 ? (
                      row.entries.map((entry) => {
                        const time = formatTimeLabel(entry.start_time);
                        const crew = crewLine(entry.job.id);
                        return (
                          <Pressable
                            key={entry.id}
                            onPress={() =>
                              router.push({
                                pathname: '/job/[id]',
                                params: { id: entry.job.id },
                              })
                            }
                            style={({ pressed }) => pressed && styles.pressed}>
                            <Text style={styles.weekJobText} numberOfLines={2}>
                              {entry.job.name}
                              {entry.job.address ? ` — ${entry.job.address}` : ''}
                              {time ? ` · ${time}` : ''}
                            </Text>
                            {crew ? <Text style={styles.crewText}>{crew}</Text> : null}
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
          </>
        )}

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
  sectionTitleTight: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
  },
  weekHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    marginBottom: spacing.xs,
  },
  weekHeaderLabel: {
    alignItems: 'center',
  },
  weekRangeText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  weekArrow: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.line,
  },
  weekArrowText: {
    color: colors.ocean,
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 24,
  },
  backToWeek: {
    alignSelf: 'center',
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginBottom: spacing.xs,
  },
  backToWeekText: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '800',
  },
  weekDayCol: {
    width: 92,
    gap: 2,
  },
  weekDay: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  weekRowToday: {
    backgroundColor: colors.skySoft,
  },
  weekDayBadge: {
    color: colors.ocean,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  weekDayBadgeSoft: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
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
  crewText: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
  },
  crewUnderCard: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  viewToggleRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  viewToggleChip: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
  },
  viewToggleChipActive: {
    backgroundColor: colors.ocean,
  },
  viewToggleText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  viewToggleTextActive: {
    color: colors.white,
  },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
  monthArrow: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.tan,
  },
  monthArrowText: {
    color: colors.ocean,
    fontSize: 22,
    fontWeight: '800',
    lineHeight: 24,
  },
  monthTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '800',
  },
  weekDayToday: {
    color: colors.ocean,
  },
  gridCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.xs,
    ...shadows.card,
  },
  gridHeaderRow: {
    flexDirection: 'row',
    paddingBottom: spacing.xs,
  },
  gridHeaderText: {
    flex: 1,
    textAlign: 'center',
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
  },
  gridWeekRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  gridCell: {
    flex: 1,
    minHeight: 64,
    padding: 2,
    alignItems: 'center',
    gap: 2,
    borderRadius: radii.sm,
  },
  gridCellSelected: {
    backgroundColor: colors.skySoft,
  },
  gridDayNumWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridDayNumToday: {
    backgroundColor: colors.ocean,
  },
  gridDayNum: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
  },
  gridDayNumOutside: {
    color: colors.tan,
  },
  gridDayNumTodayText: {
    color: colors.white,
    fontWeight: '800',
  },
  gridChip: {
    alignSelf: 'stretch',
    backgroundColor: colors.sun,
    borderRadius: 3,
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  gridChipText: {
    color: colors.ink,
    fontSize: 8,
    fontWeight: '800',
    textAlign: 'center',
  },
  gridMore: {
    color: colors.ocean,
    fontSize: 9,
    fontWeight: '800',
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
