import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { JobCard } from '@/components/JobCard';
import {
  AnimatedPressable,
  AppText,
  Card,
  Chip,
  SectionHeader,
  Screen,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { fetchAssignmentsByJob, type Assignment } from '@/lib/assignments';
import { fetchJobs, fetchScheduleEntries, fetchScheduleRange, type ScheduleEntry } from '@/lib/data';
import { todayISO } from '@/lib/dates';
import { type Job } from '@/lib/types';
import { useRole } from '@/lib/role';
import { formatTimeLabel } from '@/lib/time';

/**
 * The schedule: today's work, the Mon–Sat week, and (for admins) a month grid.
 *
 * This screen used to BE `(tabs)/index.tsx` — it was what the app opened to.
 * When Home took over that slot the calendar moved here whole: the month-grid
 * builder, the Sunday-omitting week rows, the range queries and the crew lines
 * are the same code, and the greeting, clock card, Employee of the Month card,
 * push-token registration and widget sync went to Home with it. Nothing about
 * how the schedule reads or refreshes changed.
 */

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
  const fmt = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [scheduleEntries, setScheduleEntries] = useState<ScheduleEntry[]>([]);
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

  // Refetch on every focus so stage/schedule edits made on other screens show
  // up immediately.
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      fetchJobs().then(({ jobs: fetched }) => {
        if (!cancelled) setJobs(fetched);
      });
      fetchScheduleEntries().then(({ entries }) => {
        if (!cancelled) setScheduleEntries(entries);
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
    setSelectedDay(
      grid.some((w) => w.some((d) => d.dateISO === todayStr && d.inMonth)) ? todayStr : null,
    );
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

  const today = todayISO();
  const todayEntries = scheduleEntries.filter((e) => e.work_date === today);
  const todaysJobs =
    todayEntries.length > 0
      ? todayEntries
          .map((e) => e.job)
          .filter((job, index, arr) => arr.findIndex((j) => j.id === job.id) === index)
      : jobs.filter((j) => j.scheduled_for === today);
  // The week pager has its own range query; until it lands, fall back to the
  // default ±window fetch so the week doesn't flash empty.
  const weekSource = weekEntries ?? scheduleEntries;
  const weekRows = buildWeekRows(weekSource, weekOffset);

  const openJob = (id: string) => router.push({ pathname: '/job/[id]', params: { id } });

  const note = (message: string) => (
    <Card tone="sunk">
      <AppText variant="body" color={colors.textMuted}>
        {message}
      </AppText>
    </Card>
  );

  return (
    <Screen header={<AppText variant="title">Calendar</AppText>}>
      {role?.isAdmin ? (
        <View style={styles.viewToggleRow}>
          {(['week', 'month'] as const).map((mode) => (
            <Chip
              key={mode}
              label={mode === 'week' ? 'Week' : 'Month'}
              tone="olive"
              selected={viewMode === mode}
              onPress={() => setViewMode(mode)}
            />
          ))}
        </View>
      ) : null}

      {viewMode === 'month' && role?.isAdmin ? (
        <>
          <View style={styles.pagerRow}>
            <Arrow direction="back" onPress={() => setMonthOffset((n) => n - 1)} />
            <AppText variant="heading">
              {new Date(
                new Date().getFullYear(),
                new Date().getMonth() + monthOffset,
                1,
              ).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
            </AppText>
            <Arrow direction="forward" onPress={() => setMonthOffset((n) => n + 1)} />
          </View>
          {(() => {
            const base = new Date();
            const grid = buildMonthGrid(base.getFullYear(), base.getMonth() + monthOffset);
            const entriesFor = (day: string) => monthEntries.filter((e) => e.work_date === day);
            const selectedEntries = selectedDay ? entriesFor(selectedDay) : [];
            return (
              <>
                <Card padded={false} style={styles.gridCard}>
                  <View style={styles.gridHeaderRow}>
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                      <AppText
                        key={`${d}${i}`}
                        variant="caption"
                        color={colors.textMuted}
                        align="center"
                        style={styles.gridHeaderText}>
                        {d}
                      </AppText>
                    ))}
                  </View>
                  {grid.map((week, wi) => (
                    <View key={wi} style={styles.gridWeekRow}>
                      {week.map((day) => {
                        const dayEntries = entriesFor(day.dateISO);
                        const isToday = day.dateISO === today;
                        const isSelected = day.dateISO === selectedDay;
                        return (
                          <AnimatedPressable
                            key={day.dateISO}
                            onPress={() => setSelectedDay(day.dateISO)}
                            haptic="tapLight"
                            scaleTo={0.97}
                            style={[styles.gridCell, isSelected && styles.gridCellSelected]}>
                            <View
                              style={[styles.gridDayNumWrap, isToday && styles.gridDayNumToday]}>
                              <AppText
                                variant="caption"
                                color={
                                  isToday
                                    ? colors.textOnDark
                                    : day.inMonth
                                      ? colors.textPrimary
                                      : colors.borderStrong
                                }>
                                {day.dayNum}
                              </AppText>
                            </View>
                            {/* Chips route straight to the job, matching the
                                week view; tapping elsewhere in the cell still
                                just selects the day. */}
                            {dayEntries.slice(0, 2).map((entry) => (
                              <AnimatedPressable
                                key={entry.id}
                                onPress={() => openJob(entry.job.id)}
                                haptic="tapLight"
                                hitSlop={2}
                                style={styles.gridChip}>
                                <AppText
                                  variant="caption"
                                  color={colors.ink}
                                  align="center"
                                  numberOfLines={1}
                                  style={styles.gridChipText}>
                                  {entry.job.job_number ?? entry.job.name}
                                </AppText>
                              </AnimatedPressable>
                            ))}
                            {dayEntries.length > 2 ? (
                              <AppText
                                variant="caption"
                                color={colors.accentPrimary}
                                style={styles.gridMore}>
                                +{dayEntries.length - 2}
                              </AppText>
                            ) : null}
                          </AnimatedPressable>
                        );
                      })}
                    </View>
                  ))}
                </Card>

                {monthLoading ? (
                  note('Loading…')
                ) : selectedDay ? (
                  <>
                    <SectionHeader
                      title={
                        selectedDay === today
                          ? 'Today'
                          : new Date(`${selectedDay}T12:00:00`).toLocaleDateString('en-US', {
                              weekday: 'long',
                              month: 'long',
                              day: 'numeric',
                            })
                      }
                      style={styles.sectionSpaced}
                    />
                    {selectedEntries.length === 0 ? (
                      note('Nothing scheduled.')
                    ) : (
                      <Card padded={false}>
                        {selectedEntries.map((entry, index) => {
                          const time = formatTimeLabel(entry.start_time);
                          const crew = crewLine(entry.job.id);
                          return (
                            <AnimatedPressable
                              key={entry.id}
                              onPress={() => openJob(entry.job.id)}
                              haptic="tapLight"
                              scaleTo={0.99}
                              style={[styles.dayRow, index > 0 && styles.rowBorder]}>
                              <View style={styles.dayJobs}>
                                <AppText
                                  variant="bodyStrong"
                                  color={colors.accentLink}
                                  numberOfLines={2}>
                                  {entry.job.name}
                                  {entry.job.address ? ` — ${entry.job.address}` : ''}
                                  {time ? ` · ${time}` : ''}
                                </AppText>
                                {crew ? (
                                  <AppText variant="caption" color={colors.textSecondary}>
                                    {crew}
                                  </AppText>
                                ) : null}
                              </View>
                            </AnimatedPressable>
                          );
                        })}
                      </Card>
                    )}
                  </>
                ) : (
                  note('Tap a day to see its jobs.')
                )}
              </>
            );
          })()}
        </>
      ) : (
        <>
          <SectionHeader title="Today's jobs" icon="today" />
          {todaysJobs.length > 0 ? (
            <View style={styles.jobList}>
              {todaysJobs.map((job) => (
                <View key={job.id}>
                  <JobCard job={job} subtitle="Today" />
                  {crewLine(job.id) ? (
                    <AppText
                      variant="caption"
                      color={colors.textSecondary}
                      style={styles.crewUnderCard}>
                      Crew: {crewLine(job.id)}
                    </AppText>
                  ) : null}
                </View>
              ))}
            </View>
          ) : (
            note('No jobs scheduled for today.')
          )}

          <View style={[styles.pagerRow, styles.sectionSpaced]}>
            <Arrow direction="back" onPress={() => setWeekOffset((n) => n - 1)} />
            <View style={styles.pagerLabel}>
              <AppText variant="heading">{weekTitle(weekOffset)}</AppText>
              <AppText variant="caption" color={colors.accentPrimary}>
                {weekRangeLabel(weekOffset)}
              </AppText>
            </View>
            <Arrow direction="forward" onPress={() => setWeekOffset((n) => n + 1)} />
          </View>

          {weekOffset !== 0 ? (
            <Chip
              label="Back to this week"
              tone="olive"
              onPress={() => setWeekOffset(0)}
              style={styles.backToWeek}
            />
          ) : null}

          <Card padded={false}>
            {weekRows.map((row, index) => (
              <View
                key={row.dateISO}
                style={[
                  styles.dayRow,
                  index > 0 && styles.rowBorder,
                  row.isToday && styles.dayRowToday,
                ]}>
                <View style={styles.dayCol}>
                  <AppText
                    variant="bodyStrong"
                    color={row.isToday ? colors.accentPrimary : colors.textPrimary}>
                    {row.weekday} {row.dayLabel}
                  </AppText>
                  {row.isToday ? (
                    <AppText variant="section" color={colors.accentPrimary}>
                      Today
                    </AppText>
                  ) : row.isTomorrow ? (
                    <AppText variant="caption" color={colors.textMuted}>
                      Tomorrow
                    </AppText>
                  ) : null}
                </View>
                <View style={styles.dayJobs}>
                  {row.entries.length > 0 ? (
                    row.entries.map((entry) => {
                      const time = formatTimeLabel(entry.start_time);
                      const crew = crewLine(entry.job.id);
                      return (
                        <AnimatedPressable
                          key={entry.id}
                          onPress={() => openJob(entry.job.id)}
                          haptic="tapLight"
                          scaleTo={0.99}>
                          <AppText variant="bodyStrong" color={colors.accentLink} numberOfLines={2}>
                            {entry.job.name}
                            {entry.job.address ? ` — ${entry.job.address}` : ''}
                            {time ? ` · ${time}` : ''}
                          </AppText>
                          {crew ? (
                            <AppText variant="caption" color={colors.textSecondary}>
                              {crew}
                            </AppText>
                          ) : null}
                        </AnimatedPressable>
                      );
                    })
                  ) : row.isTomorrow ? (
                    <AppText variant="body" color={colors.textMuted} style={styles.italic}>
                      No work for tomorrow
                    </AppText>
                  ) : null}
                </View>
              </View>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}

/** The ‹ › square used by both the month and the week pager. */
function Arrow({ direction, onPress }: { direction: 'back' | 'forward'; onPress: () => void }) {
  return (
    <AnimatedPressable
      onPress={onPress}
      haptic="tapLight"
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={direction === 'back' ? 'Previous' : 'Next'}
      style={styles.arrow}>
      <AppText variant="heading" color={colors.accentPrimary} style={styles.arrowGlyph}>
        {direction === 'back' ? '‹' : '›'}
      </AppText>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  viewToggleRow: {
    flexDirection: 'row',
    gap: spacing.xs,
  },
  sectionSpaced: {
    marginTop: spacing.md,
  },
  jobList: {
    gap: spacing.md,
  },
  crewUnderCard: {
    marginTop: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  italic: {
    fontStyle: 'italic',
  },
  pagerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pagerLabel: {
    alignItems: 'center',
  },
  arrow: {
    width: 36,
    height: 36,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  arrowGlyph: {
    fontSize: 22,
    lineHeight: 26,
  },
  backToWeek: {
    alignSelf: 'center',
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
  },
  rowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  dayRowToday: {
    backgroundColor: colors.oliveTint,
  },
  dayCol: {
    width: 92,
    gap: 2,
  },
  dayJobs: {
    flex: 1,
    gap: spacing.xs,
    minHeight: 18,
  },
  gridCard: {
    padding: spacing.xs,
  },
  gridHeaderRow: {
    flexDirection: 'row',
    paddingBottom: spacing.xs,
  },
  gridHeaderText: {
    flex: 1,
  },
  gridWeekRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
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
    backgroundColor: colors.oliveSoft,
  },
  gridDayNumWrap: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridDayNumToday: {
    backgroundColor: colors.accentPrimary,
  },
  gridChip: {
    alignSelf: 'stretch',
    backgroundColor: colors.sun,
    borderRadius: 3,
    paddingHorizontal: 2,
    paddingVertical: 1,
  },
  gridChipText: {
    fontSize: 8,
    lineHeight: 11,
  },
  gridMore: {
    fontSize: 9,
    lineHeight: 12,
  },
});
