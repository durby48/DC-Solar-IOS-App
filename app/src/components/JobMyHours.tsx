import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { formatShortDate, todayISO } from '@/lib/dates';
import {
  addMyHours,
  deleteMyHours,
  fetchMyHourEntries,
  updateMyHours,
  type MyHourEntry,
} from '@/lib/myhours';
import { isValidISODate } from '@/lib/time';

function formatHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/**
 * "My hours" — the signed-in member's own manual hour entries on a job:
 * total hours against a date, no clock times required. Everyone sees and
 * manages only their own entries; clocked time keeps flowing from the
 * clock in/out card separately.
 */
export function JobMyHours({
  jobId,
  email,
  onChanged,
}: {
  jobId: string;
  email: string;
  /** Called after a save/delete so parent hour totals can refresh. */
  onChanged?: () => void;
}) {
  const [entries, setEntries] = useState<MyHourEntry[]>([]);
  const [state, setState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hoursText, setHoursText] = useState('');
  const [dateText, setDateText] = useState(todayISO());
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await fetchMyHourEntries({ jobId, email });
    if (result.status === 'ok') {
      setEntries(result.entries);
      setState('ok');
    } else {
      setEntries([]);
      setState('unavailable');
    }
  }, [jobId, email]);

  useEffect(() => {
    load();
  }, [load]);

  const total = entries.reduce((sum, e) => sum + e.hours, 0);

  const openAdd = () => {
    setStatus(null);
    setEditingId(null);
    setHoursText('');
    setDateText(todayISO());
    setNoteText('');
    setFormOpen(true);
  };

  const openEdit = (entry: MyHourEntry) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(entry.id);
    setHoursText(String(entry.hours));
    setDateText(entry.occurred_on ?? todayISO());
    setNoteText(entry.description ?? '');
    setFormOpen(true);
  };

  const save = async () => {
    const hours = Number(hoursText.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setStatus({ kind: 'error', message: 'Enter hours between 0 and 24 (e.g. 2 or 2.5).' });
      return;
    }
    const day = dateText.trim();
    if (!isValidISODate(day)) {
      setStatus({ kind: 'error', message: 'Enter the date as YYYY-MM-DD (e.g. 2026-07-27).' });
      return;
    }
    setSaving(true);
    setStatus(null);
    const note = noteText.trim() || null;
    const result = editingId
      ? await updateMyHours(editingId, { hours, occurred_on: day, description: note })
      : await addMyHours({ jobId, email, hours, occurredOn: day, note });
    setSaving(false);
    if (result.ok) {
      setFormOpen(false);
      setEditingId(null);
      setStatus({
        kind: 'success',
        message: editingId ? 'Hours updated.' : `${formatHours(hours)} logged.`,
      });
      await load();
      onChanged?.();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const pressDelete = async (entry: MyHourEntry) => {
    if (confirmDeleteId !== entry.id) {
      setStatus(null);
      setConfirmDeleteId(entry.id);
      return;
    }
    setConfirmDeleteId(null);
    setDeletingId(entry.id);
    const result = await deleteMyHours(entry.id);
    setDeletingId(null);
    if (result.ok) {
      if (editingId === entry.id) {
        setFormOpen(false);
        setEditingId(null);
      }
      setStatus({ kind: 'success', message: 'Entry deleted.' });
      await load();
      onChanged?.();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  if (state === 'unavailable') return null; // pre-migration / offline — hide quietly

  return (
    <>
      <Text style={styles.sectionTitle}>My hours</Text>
      <View style={styles.card}>
        {state === 'loading' ? (
          <View style={styles.centerPad}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : (
          <>
            {entries.length === 0 ? (
              <Text style={styles.emptyText}>
                No hours logged yet. Clocked time counts automatically — add hours here when
                you worked without clocking in.
              </Text>
            ) : (
              entries.map((entry, index) => {
                const confirming = confirmDeleteId === entry.id;
                const busy = deletingId === entry.id;
                return (
                  <View key={entry.id} style={index > 0 ? styles.rowBorderTop : undefined}>
                    <View style={styles.row}>
                      <View style={styles.hoursChip}>
                        <Text style={styles.hoursChipText}>{formatHours(entry.hours)}</Text>
                      </View>
                      <View style={styles.rowBody}>
                        <Text style={styles.rowDate}>{formatShortDate(entry.occurred_on)}</Text>
                        {entry.description ? (
                          <Text style={styles.rowNote} numberOfLines={1}>
                            {entry.description}
                          </Text>
                        ) : null}
                      </View>
                      <Pressable
                        onPress={() => openEdit(entry)}
                        hitSlop={6}
                        style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
                        <Ionicons name="pencil" size={14} color={colors.ocean} />
                      </Pressable>
                      <Pressable
                        onPress={() => void pressDelete(entry)}
                        disabled={busy}
                        hitSlop={6}
                        style={({ pressed }) => [
                          styles.iconButton,
                          confirming && styles.iconButtonDanger,
                          pressed && styles.pressed,
                        ]}>
                        {busy ? (
                          <ActivityIndicator size="small" color={colors.danger} />
                        ) : (
                          <Ionicons
                            name="trash"
                            size={14}
                            color={confirming ? colors.white : colors.inkSoft}
                          />
                        )}
                      </Pressable>
                    </View>
                    {confirming ? (
                      <Text style={styles.confirmHint}>Tap the trash again to delete.</Text>
                    ) : null}
                  </View>
                );
              })
            )}

            {entries.length > 0 ? (
              <View style={styles.totalRow}>
                <Text style={styles.totalLabel}>Logged here</Text>
                <Text style={styles.totalValue}>{formatHours(total)}</Text>
              </View>
            ) : null}

            {formOpen ? (
              <View style={styles.formArea}>
                <Text style={styles.fieldLabel}>Hours (e.g. 2 or 2.5)</Text>
                <TextInput
                  style={styles.input}
                  value={hoursText}
                  onChangeText={setHoursText}
                  placeholder="0"
                  placeholderTextColor={colors.inkSoft}
                  keyboardType="decimal-pad"
                />
                <Text style={styles.fieldLabel}>Date (YYYY-MM-DD)</Text>
                <TextInput
                  style={styles.input}
                  value={dateText}
                  onChangeText={setDateText}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.inkSoft}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Text style={styles.fieldLabel}>Note (optional)</Text>
                <TextInput
                  style={styles.input}
                  value={noteText}
                  onChangeText={setNoteText}
                  placeholder="e.g. finished rail teardown"
                  placeholderTextColor={colors.inkSoft}
                />
                <View style={styles.formButtons}>
                  <Pressable
                    onPress={() => {
                      setFormOpen(false);
                      setEditingId(null);
                    }}
                    disabled={saving}
                    hitSlop={8}>
                    <Text style={styles.cancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => void save()}
                    disabled={saving}
                    style={({ pressed }) => [
                      styles.saveButton,
                      (pressed || saving) && styles.pressed,
                    ]}>
                    {saving ? (
                      <ActivityIndicator color={colors.ink} />
                    ) : (
                      <Text style={styles.saveButtonText}>
                        {editingId ? 'Save' : 'Log hours'}
                      </Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable
                onPress={openAdd}
                style={({ pressed }) => [styles.addRow, pressed && styles.pressed]}>
                <Ionicons name="add-circle" size={18} color={colors.ocean} />
                <Text style={styles.addRowText}>Log hours</Text>
              </Pressable>
            )}
          </>
        )}
      </View>

      {status ? (
        <Text
          style={[
            styles.statusText,
            status.kind === 'error' ? styles.statusError : styles.statusSuccess,
          ]}>
          {status.message}
        </Text>
      ) : null}
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
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  centerPad: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  emptyText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  hoursChip: {
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    minWidth: 52,
    alignItems: 'center',
  },
  hoursChipText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  rowBody: {
    flex: 1,
    gap: 1,
  },
  rowDate: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  rowNote: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  iconButton: {
    width: 26,
    height: 26,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  confirmHint: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'right',
    paddingBottom: spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
    paddingTop: spacing.xs + 2,
  },
  totalLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  totalValue: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  formArea: {
    backgroundColor: colors.cream,
    borderRadius: radii.sm,
    padding: spacing.md,
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  formButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  cancelText: {
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
    ...shadows.card,
  },
  saveButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  addRowText: {
    color: colors.ocean,
    fontSize: 14,
    fontWeight: '700',
  },
  pressed: {
    opacity: 0.7,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusError: {
    color: colors.danger,
  },
  statusSuccess: {
    color: colors.ocean,
  },
});
