import Ionicons from '@expo/vector-icons/Ionicons';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  addJobScheduleDate,
  deleteJobScheduleDate,
  fetchJobScheduleDates,
  updateJobScheduleDate,
  type ScheduleDate,
} from '@/lib/data';
import { formatShortDate, parseISODate } from '@/lib/dates';
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

/** 'HH:MM' or 'HH:MM:SS' → a Date today at that wall-clock time. */
function timeToDate(time: string): Date {
  const [h, m] = time.split(':');
  const d = new Date();
  d.setHours(Number(h) || 0, Number(m) || 0, 0, 0);
  return d;
}

/**
 * "Scheduled days" card for a job. All members see the list; admins can add
 * and remove days. In demo mode (mock data) the list is read-only.
 */
export function JobScheduleDates({ jobId, isAdmin }: { jobId: string; isAdmin: boolean }) {
  const [dates, setDates] = useState<ScheduleDate[]>([]);
  const [loading, setLoading] = useState(true);
  const [isMock, setIsMock] = useState(false);
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
      setIsMock(result.isMock);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  const canEdit = isAdmin && !isMock;

  const resetForm = useCallback(() => {
    setShowForm(false);
    setSaving(false);
    setDraftDate(null);
    setDraftTime(null);
    setPickerMode(null);
    setDateText('');
    setTimeText('');
    setError(null);
  }, []);

  const saveDay = async (workDate: string, startTime: string | null) => {
    setSaving(true);
    setError(null);
    const result = await addJobScheduleDate({ jobId, workDate, startTime });
    if (result.ok) {
      setDates((prev) => sortDates([...prev, result.date]));
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
      <Text style={styles.sectionTitle}>Scheduled days</Text>
      {loading ? (
        <View style={styles.placeholderCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      ) : dates.length === 0 ? (
        <View style={styles.placeholderCard}>
          <Ionicons name="calendar" size={22} color={colors.inkSoft} />
          <Text style={styles.placeholderText}>No days scheduled yet</Text>
        </View>
      ) : (
        <View style={styles.card}>
          {dates.map((entry, index) => {
            const isEditing = editingId === entry.id;
            const rowContent = (
              <>
                <View style={styles.iconWrap}>
                  <Ionicons name="calendar" size={18} color={colors.ocean} />
                </View>
                <View style={styles.rowBody}>
                  <Text style={styles.rowValue}>
                    {formatShortDate(entry.work_date)} —{' '}
                    {formatTimeLabel(entry.start_time) ?? 'time TBD'}
                  </Text>
                  {entry.note ? <Text style={styles.rowNote}>{entry.note}</Text> : null}
                </View>
                {canEdit ? (
                  <Ionicons
                    name={isEditing ? 'chevron-up' : 'create-outline'}
                    size={16}
                    color={colors.inkSoft}
                  />
                ) : null}
                {canEdit ? (
                  <Pressable
                    onPress={() => confirmRemove(entry)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}>
                    <Ionicons name="close" size={16} color={colors.danger} />
                  </Pressable>
                ) : null}
              </>
            );
            return (
              <View key={entry.id} style={index > 0 ? styles.rowBorderTop : null}>
                {canEdit ? (
                  <Pressable
                    onPress={() => (isEditing ? cancelEdit() : startEdit(entry))}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                    {rowContent}
                  </Pressable>
                ) : (
                  <View style={styles.row}>{rowContent}</View>
                )}

                {canEdit && isEditing ? (
                  <View style={styles.editForm}>
                    {Platform.OS === 'web' ? (
                      <View style={styles.fieldRow}>
                        <Text style={styles.fieldLabel}>Start time</Text>
                        <TextInput
                          value={editTimeText}
                          onChangeText={setEditTimeText}
                          placeholder="HH:MM (blank = TBD)"
                          placeholderTextColor={colors.inkSoft}
                          style={styles.input}
                          autoCapitalize="none"
                        />
                        {editTimeText ? (
                          <Pressable onPress={() => setEditTimeText('')} hitSlop={4}>
                            <Text style={styles.skipTime}>Clear</Text>
                          </Pressable>
                        ) : null}
                      </View>
                    ) : (
                      <>
                        <Pressable
                          onPress={() => setEditPickerOpen((open) => !open)}
                          style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}>
                          <Text style={styles.fieldLabel}>Start time</Text>
                          <Text style={styles.fieldValue}>
                            {editDraftTime
                              ? (formatTimeLabel(toHHMM(editDraftTime)) ?? 'TBD')
                              : 'Time TBD'}
                          </Text>
                        </Pressable>
                        {editDraftTime ? (
                          <Pressable onPress={() => setEditDraftTime(null)} hitSlop={4}>
                            <Text style={styles.skipTime}>Clear time (set TBD)</Text>
                          </Pressable>
                        ) : null}
                        {editPickerOpen ? (
                          <DateTimePicker
                            value={editDraftTime ?? new Date()}
                            mode="time"
                            display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                            themeVariant="light"
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
                      <Pressable
                        onPress={cancelEdit}
                        disabled={editSaving}
                        style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                        <Text style={styles.cancelButtonText}>Cancel</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => void saveEditedTime(entry)}
                        disabled={editSaving}
                        style={({ pressed }) => [
                          styles.saveButton,
                          (pressed || editSaving) && styles.pressed,
                        ]}>
                        {editSaving ? (
                          <ActivityIndicator color={colors.ink} size="small" />
                        ) : (
                          <Text style={styles.saveButtonText}>Save time</Text>
                        )}
                      </Pressable>
                    </View>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {canEdit && !showForm ? (
        <Pressable
          onPress={() => {
            cancelEdit();
            setShowForm(true);
          }}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
          <Ionicons name="add" size={18} color={colors.ink} />
          <Text style={styles.addButtonText}>Add day</Text>
        </Pressable>
      ) : null}

      {canEdit && showForm ? (
        <View style={styles.formCard}>
          {Platform.OS === 'web' ? (
            <>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Date</Text>
                <TextInput
                  value={dateText}
                  onChangeText={setDateText}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.inkSoft}
                  style={styles.input}
                  autoCapitalize="none"
                />
              </View>
              <View style={styles.fieldRow}>
                <Text style={styles.fieldLabel}>Start time</Text>
                <TextInput
                  value={timeText}
                  onChangeText={setTimeText}
                  placeholder="HH:MM (blank = TBD)"
                  placeholderTextColor={colors.inkSoft}
                  style={styles.input}
                  autoCapitalize="none"
                />
              </View>
            </>
          ) : (
            <>
              <Pressable
                onPress={() => setPickerMode(pickerMode === 'date' ? null : 'date')}
                style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}>
                <Text style={styles.fieldLabel}>Date</Text>
                <Text style={styles.fieldValue}>
                  {draftDate ? formatShortDate(toISODate(draftDate)) : 'Pick a date'}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setPickerMode(pickerMode === 'time' ? null : 'time')}
                style={({ pressed }) => [styles.fieldRow, pressed && styles.pressed]}>
                <Text style={styles.fieldLabel}>Start time</Text>
                <Text style={styles.fieldValue}>
                  {draftTime ? (formatTimeLabel(toHHMM(draftTime)) ?? 'TBD') : 'Time TBD'}
                </Text>
              </Pressable>
              {draftTime ? (
                <Pressable onPress={() => setDraftTime(null)} hitSlop={4}>
                  <Text style={styles.skipTime}>Skip time (leave TBD)</Text>
                </Pressable>
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
                  themeVariant="light"
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
            <Pressable
              onPress={resetForm}
              disabled={saving}
              style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </Pressable>
            <Pressable
              onPress={Platform.OS === 'web' ? submitWeb : submitNative}
              disabled={saving}
              style={({ pressed }) => [
                styles.saveButton,
                (pressed || saving) && styles.pressed,
              ]}>
              {saving ? (
                <ActivityIndicator color={colors.ink} size="small" />
              ) : (
                <Text style={styles.saveButtonText}>Save day</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}

      {error ? <Text style={styles.errorText}>{error}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  placeholderCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.xs,
  },
  placeholderText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
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
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 2,
  },
  rowValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  rowNote: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  removeButton: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.7,
  },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    alignSelf: 'flex-start',
  },
  addButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  fieldValue: {
    color: colors.ocean,
    fontSize: 15,
    fontWeight: '700',
  },
  skipTime: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
  input: {
    flex: 1,
    maxWidth: 220,
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs + 2,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: colors.cream,
  },
  formButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  cancelButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
  },
  cancelButtonText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
});
