import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing, typography } from '@/constants/theme';
import {
  addJobScheduleDate,
  addJobScheduleDates,
  deleteJobScheduleDate,
  fetchJobScheduleDates,
  updateJobScheduleDate,
  type ScheduleDate,
} from '@/lib/data';
import { formatShortDate, parseISODate } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import {
  formatTimeLabel,
  isValidHHMM,
  isValidISODate,
  toHHMM,
  toISODate,
} from '@/lib/time';

function sortDates(dates: ScheduleDate[]): ScheduleDate[] {
  return [...dates].sort((a, b) => a.work_date.localeCompare(b.work_date));
}

/** ISO weekday (1 = Mon … 7 = Sun) labels for the "Several days" picker. */
const WEEKDAYS: { iso: number; label: string }[] = [
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
];
/** Longest range one save may add — a typo'd year must not create 300 days. */
const MAX_RANGE_DAYS = 62;

/** Every YYYY-MM-DD from `start` to `end` (inclusive) whose weekday is ticked. */
function datesInRange(start: string, end: string, weekdays: Set<number>): string[] {
  if (!isValidISODate(start) || !isValidISODate(end) || end < start) return [];
  const out: string[] = [];
  const d = parseISODate(start);
  for (let i = 0; i <= MAX_RANGE_DAYS; i += 1) {
    const iso = toISODate(d);
    if (iso > end) break;
    const dow = d.getDay() === 0 ? 7 : d.getDay();
    if (weekdays.has(dow)) out.push(iso);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/** 'HH:MM' or 'HH:MM:SS' → a Date today at that wall-clock time. */
function timeToDate(time: string): Date {
  const [h, m] = time.split(':');
  const d = new Date();
  d.setHours(Number(h) || 0, Number(m) || 0, 0, 0);
  return d;
}

/**
 * "Scheduled days" card for a job. All members see the list; admins can add
 * and remove days — RLS is the real barrier, `isAdmin` only draws the buttons.
 *
 * 2026-08-22 restyle: `Card`, `Button`, `EmptyState` and `SkeletonList` from
 * the kit. Both platform splits stay exactly as they were: the native date/
 * time pickers vs. the web text fields, and the Alert-on-native vs.
 * remove-immediately-on-web confirmation.
 */
export function JobScheduleDates({ jobId, isAdmin }: { jobId: string; isAdmin: boolean }) {
  const [dates, setDates] = useState<ScheduleDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Add-day form state
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  // Native picker state
  const [draftDate, setDraftDate] = useState<Date | null>(null);
  const [draftTime, setDraftTime] = useState<Date | null>(null);
  const [pickerMode, setPickerMode] = useState<'date' | 'time' | null>(null);
  // Web text-input state
  const [dateText, setDateText] = useState('');
  const [timeText, setTimeText] = useState('');
  // "Several days" (2026-10-14): a first/last day range filtered by weekday, one save.
  const [mode, setMode] = useState<'one' | 'range'>('one');
  const [rangeStartText, setRangeStartText] = useState('');
  const [rangeEndText, setRangeEndText] = useState('');
  const [rangeStart, setRangeStart] = useState<Date | null>(null); // native
  const [rangeEnd, setRangeEnd] = useState<Date | null>(null); // native
  const [rangePicker, setRangePicker] = useState<'start' | 'end' | null>(null); // native
  const [weekdays, setWeekdays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5, 6]));

  // Edit-time state (admins tap an existing row to change its start time)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editDraftTime, setEditDraftTime] = useState<Date | null>(null); // native
  const [editPickerOpen, setEditPickerOpen] = useState(false); // native
  const [editTimeText, setEditTimeText] = useState(''); // web

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchJobScheduleDates(jobId).then((result) => {
      if (cancelled) return;
      setDates(sortDates(result.dates));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const canEdit = isAdmin;

  const resetForm = useCallback(() => {
    setShowForm(false);
    setSaving(false);
    setDraftDate(null);
    setDraftTime(null);
    setPickerMode(null);
    setDateText('');
    setTimeText('');
    setMode('one');
    setRangeStartText('');
    setRangeEndText('');
    setRangeStart(null);
    setRangeEnd(null);
    setRangePicker(null);
    setError(null);
  }, []);

  const saveDay = async (workDate: string, startTime: string | null) => {
    setSaving(true);
    setError(null);
    const result = await addJobScheduleDate({ jobId, workDate, startTime });
    if (result.ok) {
      setDates((prev) => sortDates([...prev, result.date]));
      haptics.success();
      resetForm();
    } else {
      setSaving(false);
      setError(result.message);
    }
  };

  // The range as YYYY-MM-DD strings, from whichever inputs this platform uses.
  const rangeStartISO = Platform.OS === 'web' ? rangeStartText.trim() : rangeStart ? toISODate(rangeStart) : '';
  const rangeEndISO = Platform.OS === 'web' ? rangeEndText.trim() : rangeEnd ? toISODate(rangeEnd) : '';
  const rangeDays = datesInRange(rangeStartISO, rangeEndISO, weekdays);
  const alreadyScheduled = new Set(dates.map((d) => d.work_date));
  const rangeNew = rangeDays.filter((d) => !alreadyScheduled.has(d));

  const toggleWeekday = (iso: number) =>
    setWeekdays((cur) => {
      const next = new Set(cur);
      if (next.has(iso)) next.delete(iso);
      else next.add(iso);
      return next;
    });

  const saveRange = async () => {
    if (!isValidISODate(rangeStartISO) || !isValidISODate(rangeEndISO)) {
      setError(Platform.OS === 'web' ? 'Enter the first and last day as YYYY-MM-DD.' : 'Pick the first and last day.');
      return;
    }
    if (rangeEndISO < rangeStartISO) {
      setError('The last day is before the first day.');
      return;
    }
    let startTime: string | null;
    if (Platform.OS === 'web') {
      const time = timeText.trim();
      if (time && !isValidHHMM(time)) {
        setError('Enter the time as HH:MM (24h), or leave it blank for TBD.');
        return;
      }
      startTime = time || null;
    } else {
      startTime = draftTime ? toHHMM(draftTime) : null;
    }
    if (rangeNew.length === 0) {
      setError(rangeDays.length ? 'Every one of those days is already scheduled.' : 'No days match — tick at least one weekday.');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await addJobScheduleDates({ jobId, workDates: rangeNew, startTime });
    if (result.ok) {
      setDates((prev) => sortDates([...prev, ...result.dates]));
      haptics.success();
      resetForm();
    } else {
      setSaving(false);
      setError(result.message);
    }
  };

  const submitNative = () => {
    if (!draftDate) {
      setError('Pick a date first.');
      return;
    }
    saveDay(toISODate(draftDate), draftTime ? toHHMM(draftTime) : null);
  };

  const submitWeb = () => {
    const date = dateText.trim();
    const time = timeText.trim();
    if (!isValidISODate(date)) {
      setError('Enter the date as YYYY-MM-DD.');
      return;
    }
    if (time && !isValidHHMM(time)) {
      setError('Enter the time as HH:MM (24h), or leave it blank for TBD.');
      return;
    }
    saveDay(date, time || null);
  };

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setEditSaving(false);
    setEditDraftTime(null);
    setEditPickerOpen(false);
    setEditTimeText('');
    setError(null);
  }, []);

  const startEdit = (entry: ScheduleDate) => {
    resetForm(); // close the add-day form if it's open
    setEditingId(entry.id);
    setEditSaving(false);
    setEditPickerOpen(false);
    setEditDraftTime(entry.start_time ? timeToDate(entry.start_time) : null);
    setEditTimeText(entry.start_time ? entry.start_time.slice(0, 5) : '');
    setError(null);
  };

  const saveEditedTime = async (entry: ScheduleDate) => {
    let startTime: string | null;
    if (Platform.OS === 'web') {
      const time = editTimeText.trim();
      if (time && !isValidHHMM(time)) {
        setError('Enter the time as HH:MM (24h), or clear it for TBD.');
        return;
      }
      startTime = time || null;
    } else {
      startTime = editDraftTime ? toHHMM(editDraftTime) : null;
    }
    setEditSaving(true);
    setError(null);
    const result = await updateJobScheduleDate(entry.id, startTime);
    if (result.ok) {
      setDates((prev) => sortDates(prev.map((d) => (d.id === entry.id ? result.date : d))));
      haptics.success();
      cancelEdit();
    } else {
      setEditSaving(false);
      setError(result.message);
    }
  };

  const removeDay = async (entry: ScheduleDate) => {
    const ok = await deleteJobScheduleDate(entry.id);
    if (ok) {
      setDates((prev) => prev.filter((d) => d.id !== entry.id));
      setError(null);
    } else {
      setError('Could not remove that day.');
    }
  };

  const confirmRemove = (entry: ScheduleDate) => {
    if (Platform.OS === 'web') {
      removeDay(entry);
      return;
    }
    Alert.alert('Remove day', `Remove ${formatShortDate(entry.work_date)} from this job?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeDay(entry) },
    ]);
  };

  return (
    <>
      <SectionHeader title="Scheduled days" icon="calendar" style={styles.section} />
      {loading ? (
        <SkeletonList count={2} height={56} />
      ) : dates.length === 0 ? (
        <EmptyState
          icon="calendar"
          title="No days scheduled yet"
          body={
            canEdit
              ? 'Add the days the crew is expected on site and they show up on the calendar.'
              : 'Days appear here once the office schedules them.'
          }
        />
      ) : (
        <Card padded={false}>
          {dates.map((entry, index) => {
            const isEditing = editingId === entry.id;
            const rowContent = (
              <>
                <View style={styles.iconWrap}>
                  <Ionicons name="calendar" size={18} color={colors.accentPrimary} />
                </View>
                <View style={styles.rowBody}>
                  <AppText variant="bodyStrong">
                    {formatShortDate(entry.work_date)} —{' '}
                    {formatTimeLabel(entry.start_time) ?? 'time TBD'}
                  </AppText>
                  {entry.note ? (
                    <AppText variant="caption" color={colors.textMuted}>
                      {entry.note}
                    </AppText>
                  ) : null}
                </View>
                {canEdit ? (
                  <Ionicons
                    name={isEditing ? 'chevron-up' : 'create-outline'}
                    size={16}
                    color={colors.textMuted}
                  />
                ) : null}
                {canEdit ? (
                  <AnimatedPressable
                    onPress={() => confirmRemove(entry)}
                    haptic="tapLight"
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${formatShortDate(entry.work_date)}`}
                    style={styles.removeButton}>
                    <Ionicons name="close" size={16} color={colors.danger} />
                  </AnimatedPressable>
                ) : null}
              </>
            );
            return (
              <View key={entry.id} style={index > 0 ? styles.rowBorderTop : null}>
                {canEdit ? (
                  <AnimatedPressable
                    onPress={() => (isEditing ? cancelEdit() : startEdit(entry))}
                    haptic="tapLight"
                    scaleTo={0.99}
                    accessibilityRole="button"
                    accessibilityLabel={`Edit ${formatShortDate(entry.work_date)}`}
                    style={styles.row}>
                    {rowContent}
                  </AnimatedPressable>
                ) : (
                  <View style={styles.row}>{rowContent}</View>
                )}

                {canEdit && isEditing ? (
                  <View style={styles.editForm}>
                    {Platform.OS === 'web' ? (
                      <View style={styles.fieldRow}>
                        <AppText variant="section" color={colors.textMuted}>
                          Start time
                        </AppText>
                        <TextInput
                          value={editTimeText}
                          onChangeText={setEditTimeText}
                          placeholder="HH:MM (blank = TBD)"
                          placeholderTextColor={colors.textMuted}
                          style={styles.input}
                          autoCapitalize="none"
                        />
                        {editTimeText ? (
                          <AnimatedPressable onPress={() => setEditTimeText('')} hitSlop={4}>
                            <AppText
                              variant="caption"
                              color={colors.textMuted}
                              style={styles.skipTime}>
                              Clear
                            </AppText>
                          </AnimatedPressable>
                        ) : null}
                      </View>
                    ) : (
                      <>
                        <AnimatedPressable
                          onPress={() => setEditPickerOpen((open) => !open)}
                          haptic="tapLight"
                          style={styles.fieldRow}>
                          <AppText variant="section" color={colors.textMuted}>
                            Start time
                          </AppText>
                          <AppText variant="bodyStrong" color={colors.accentPrimary}>
                            {editDraftTime
                              ? (formatTimeLabel(toHHMM(editDraftTime)) ?? 'TBD')
                              : 'Time TBD'}
                          </AppText>
                        </AnimatedPressable>
                        {editDraftTime ? (
                          <AnimatedPressable onPress={() => setEditDraftTime(null)} hitSlop={4}>
                            <AppText
                              variant="caption"
                              color={colors.textMuted}
                              style={styles.skipTime}>
                              Clear time (set TBD)
                            </AppText>
                          </AnimatedPressable>
                        ) : null}
                        {editPickerOpen ? (
                          <DateTimePicker
                            value={editDraftTime ?? new Date()}
                            mode="time"
                            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                            themeVariant="dark"
                            onChange={(event, selected) => {
                              if (Platform.OS !== 'ios') setEditPickerOpen(false);
                              if (event.type === 'set' && selected) {
                                setEditDraftTime(selected);
                              }
                            }}
                          />
                        ) : null}
                      </>
                    )}
                    <View style={styles.formButtons}>
                      <Button
                        label="Cancel"
                        onPress={cancelEdit}
                        variant="ghost"
                        size="sm"
                        disabled={editSaving}
                      />
                      <Button
                        label="Save time"
                        onPress={() => void saveEditedTime(entry)}
                        loading={editSaving}
                        size="sm"
                      />
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </Card>
      )}

      {canEdit && !showForm ? (
        <Button
          label="Add days"
          onPress={() => {
            cancelEdit();
            setShowForm(true);
          }}
          variant="secondary"
          size="sm"
          icon="add"
        />
      ) : null}

      {canEdit && showForm ? (
        <Card style={styles.formCard}>
          <View style={styles.modeRow}>
            <Chip label="One day" tone="olive" selected={mode === 'one'} onPress={() => setMode('one')} />
            <Chip label="Several days" tone="olive" selected={mode === 'range'} onPress={() => setMode('range')} />
          </View>
          {mode === 'range' ? (
            <View style={styles.rangeBlock}>
              {Platform.OS === 'web' ? (
                <>
                  <View style={styles.fieldRow}>
                    <AppText variant="section" color={colors.textMuted}>
                      First day
                    </AppText>
                    <TextInput
                      value={rangeStartText}
                      onChangeText={setRangeStartText}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      autoCapitalize="none"
                    />
                  </View>
                  <View style={styles.fieldRow}>
                    <AppText variant="section" color={colors.textMuted}>
                      Last day
                    </AppText>
                    <TextInput
                      value={rangeEndText}
                      onChangeText={setRangeEndText}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.textMuted}
                      style={styles.input}
                      autoCapitalize="none"
                    />
                  </View>
                </>
              ) : (
                <>
                  <AnimatedPressable
                    onPress={() => setRangePicker(rangePicker === 'start' ? null : 'start')}
                    haptic="tapLight"
                    style={styles.fieldRow}>
                    <AppText variant="section" color={colors.textMuted}>
                      First day
                    </AppText>
                    <AppText variant="bodyStrong" color={colors.accentPrimary}>
                      {rangeStart ? formatShortDate(toISODate(rangeStart)) : 'Pick a date'}
                    </AppText>
                  </AnimatedPressable>
                  <AnimatedPressable
                    onPress={() => setRangePicker(rangePicker === 'end' ? null : 'end')}
                    haptic="tapLight"
                    style={styles.fieldRow}>
                    <AppText variant="section" color={colors.textMuted}>
                      Last day
                    </AppText>
                    <AppText variant="bodyStrong" color={colors.accentPrimary}>
                      {rangeEnd ? formatShortDate(toISODate(rangeEnd)) : 'Pick a date'}
                    </AppText>
                  </AnimatedPressable>
                  {rangePicker ? (
                    <DateTimePicker
                      value={(rangePicker === 'start' ? rangeStart : rangeEnd) ?? rangeStart ?? parseISODate(toISODate(new Date()))}
                      mode="date"
                      display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                      themeVariant="dark"
                      onChange={(event, selected) => {
                        const which = rangePicker;
                        if (Platform.OS !== 'ios') setRangePicker(null);
                        if (event.type === 'set' && selected) {
                          if (which === 'start') setRangeStart(selected);
                          else setRangeEnd(selected);
                        }
                      }}
                    />
                  ) : null}
                </>
              )}
              <View style={styles.modeRow}>
                {WEEKDAYS.map((w) => (
                  <Chip
                    key={w.iso}
                    label={w.label}
                    tone="sun"
                    selected={weekdays.has(w.iso)}
                    onPress={() => toggleWeekday(w.iso)}
                  />
                ))}
              </View>
              <AppText variant="caption" color={colors.textMuted}>
                {rangeDays.length === 0
                  ? 'Pick the first and last day; only the ticked weekdays are scheduled.'
                  : `Adds ${rangeNew.length} ${rangeNew.length === 1 ? 'day' : 'days'}${
                      rangeNew.length
                        ? `: ${rangeNew.slice(0, 8).map((d) => formatShortDate(d)).join(', ')}${rangeNew.length > 8 ? ', …' : ''}`
                        : ''
                    }${
                      rangeDays.length > rangeNew.length ? ` (${rangeDays.length - rangeNew.length} already scheduled)` : ''
                    }. The crew gets one notification.`}
              </AppText>
            </View>
          ) : null}
          {Platform.OS === 'web' ? (
            <>
              {mode === 'one' ? (
                <View style={styles.fieldRow}>
                  <AppText variant="section" color={colors.textMuted}>
                    Date
                  </AppText>
                  <TextInput
                    value={dateText}
                    onChangeText={setDateText}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                    autoCapitalize="none"
                  />
                </View>
              ) : null}
              <View style={styles.fieldRow}>
                <AppText variant="section" color={colors.textMuted}>
                  Start time
                </AppText>
                <TextInput
                  value={timeText}
                  onChangeText={setTimeText}
                  placeholder="HH:MM (blank = TBD)"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                  autoCapitalize="none"
                />
              </View>
            </>
          ) : (
            <>
              {mode === 'one' ? (
                <AnimatedPressable
                  onPress={() => setPickerMode(pickerMode === 'date' ? null : 'date')}
                  haptic="tapLight"
                  style={styles.fieldRow}>
                  <AppText variant="section" color={colors.textMuted}>
                    Date
                  </AppText>
                  <AppText variant="bodyStrong" color={colors.accentPrimary}>
                    {draftDate ? formatShortDate(toISODate(draftDate)) : 'Pick a date'}
                  </AppText>
                </AnimatedPressable>
              ) : null}
              <AnimatedPressable
                onPress={() => setPickerMode(pickerMode === 'time' ? null : 'time')}
                haptic="tapLight"
                style={styles.fieldRow}>
                <AppText variant="section" color={colors.textMuted}>
                  Start time
                </AppText>
                <AppText variant="bodyStrong" color={colors.accentPrimary}>
                  {draftTime ? (formatTimeLabel(toHHMM(draftTime)) ?? 'TBD') : 'Time TBD'}
                </AppText>
              </AnimatedPressable>
              {draftTime ? (
                <AnimatedPressable onPress={() => setDraftTime(null)} hitSlop={4}>
                  <AppText variant="caption" color={colors.textMuted} style={styles.skipTime}>
                    Skip time (leave TBD)
                  </AppText>
                </AnimatedPressable>
              ) : null}
              {pickerMode ? (
                <DateTimePicker
                  value={
                    pickerMode === 'date'
                      ? (draftDate ?? parseISODate(toISODate(new Date())))
                      : (draftTime ?? new Date())
                  }
                  mode={pickerMode}
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  themeVariant="dark"
                  onChange={(event, selected) => {
                    if (Platform.OS !== 'ios') setPickerMode(null);
                    if (event.type === 'set' && selected) {
                      if (pickerMode === 'date') setDraftDate(selected);
                      else setDraftTime(selected);
                    }
                  }}
                />
              ) : null}
            </>
          )}

          <View style={styles.formButtons}>
            <Button
              label="Cancel"
              onPress={resetForm}
              variant="ghost"
              size="sm"
              disabled={saving}
            />
            <Button
              label={
                mode === 'range'
                  ? rangeNew.length
                    ? `Save ${rangeNew.length} ${rangeNew.length === 1 ? 'day' : 'days'}`
                    : 'Save days'
                  : 'Save day'
              }
              onPress={mode === 'range' ? () => void saveRange() : Platform.OS === 'web' ? submitWeb : submitNative}
              loading={saving}
              size="sm"
            />
          </View>
        </Card>
      ) : null}

      {error ? (
        <AppText variant="caption" align="center" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  editForm: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  removeButton: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formCard: {
    gap: spacing.sm,
  },
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  rangeBlock: {
    gap: spacing.sm,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  skipTime: {
    textDecorationLine: 'underline',
  },
  input: {
    flex: 1,
    maxWidth: 220,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
    color: colors.textPrimary,
    backgroundColor: colors.surfaceAlt,
    ...typography.body,
  },
  formButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
