import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TextInput, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  Pill,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing, typography } from '@/constants/theme';
import { formatShortDate, todayISO } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import {
  addMyHours,
  addMyHoursForMany,
  deleteMyHours,
  fetchEmployeeOptions,
  fetchMyHourEntries,
  updateMyHours,
  type EmployeeOption,
  type MyHourEntry,
} from '@/lib/myhours';
import { isValidISODate } from '@/lib/time';

function formatHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

/**
 * Manual hour entries on a job: total hours against a date, no clock times
 * required. Crew see and manage only their own entries; admins (isAdmin)
 * see every employee's entries, can edit/delete all of them, and can log
 * hours on any employee's behalf via the picker. Clocked time keeps
 * flowing from the clock in/out card separately.
 *
 * 2026-08-22 restyle: kit primitives throughout — `Card`, `Pill` for the
 * hours badge, `Chip` for the employee picker, `Button` for save, and a
 * `SkeletonList` where the first-load spinner was. The two-tap delete
 * confirm, the 0–24 hour validation and the admin/crew split are unchanged.
 */
export function JobMyHours({
  jobId,
  email,
  isAdmin = false,
  onChanged,
}: {
  jobId: string;
  email: string;
  isAdmin?: boolean;
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
  // Admin: who the new entry is for (defaults to the admin themself).
  //
  // A LIST, not one email: the crew works a job together, so "everyone did 8
  // hours" was six trips through this form. Editing stays single — an existing
  // row belongs to one person and reassigning it is not what the pencil means.
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [targetEmails, setTargetEmails] = useState<string[]>([email]);

  const toggleTarget = (candidate: string) =>
    setTargetEmails((current) =>
      current.some((e) => e.toLowerCase() === candidate.toLowerCase())
        ? current.filter((e) => e.toLowerCase() !== candidate.toLowerCase())
        : [...current, candidate],
    );

  const allSelected = employees.length > 0 && targetEmails.length === employees.length;

  const load = useCallback(async () => {
    const result = await fetchMyHourEntries({ jobId, email, allEmployees: isAdmin });
    if (result.status === 'ok') {
      setEntries(result.entries);
      setState('ok');
    } else {
      setEntries([]);
      setState('unavailable');
    }
  }, [jobId, email, isAdmin]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchEmployeeOptions().then(setEmployees);
  }, [isAdmin]);

  const total = entries.reduce((sum, e) => sum + e.hours, 0);

  const openAdd = () => {
    setStatus(null);
    setEditingId(null);
    setHoursText('');
    setDateText(todayISO());
    setNoteText('');
    setTargetEmails([email]);
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
    if (isAdmin && !editingId && targetEmails.length === 0) {
      setStatus({ kind: 'error', message: 'Pick at least one person.' });
      return;
    }
    setSaving(true);
    setStatus(null);
    const note = noteText.trim() || null;
    // Admins log for a list (one insert, all-or-nothing); crew log for
    // themselves; editing always touches exactly the one row being edited.
    const people = isAdmin ? targetEmails.length : 1;
    const result = editingId
      ? await updateMyHours(editingId, { hours, occurred_on: day, description: note })
      : isAdmin
        ? await addMyHoursForMany({ jobId, emails: targetEmails, hours, occurredOn: day, note })
        : await addMyHours({ jobId, email, hours, occurredOn: day, note });
    setSaving(false);
    if (result.ok) {
      setFormOpen(false);
      setEditingId(null);
      haptics.success();
      setStatus({
        kind: 'success',
        message: editingId
          ? 'Hours updated.'
          : `${formatHours(hours)} logged${people > 1 ? ` for ${people} people` : ''}.`,
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
      <SectionHeader
        title={isAdmin ? 'Hours' : 'My hours'}
        icon="time-outline"
        style={styles.section}
      />
      <Card style={styles.card}>
        {state === 'loading' ? (
          <SkeletonList count={2} height={28} radius={radii.sm} />
        ) : (
          <>
            {entries.length === 0 ? (
              <AppText variant="caption" color={colors.textMuted}>
                {isAdmin
                  ? 'No hour entries on this job yet. Log hours for yourself or any employee below.'
                  : 'No hours logged yet. Clocked time counts automatically — add hours here when you worked without clocking in.'}
              </AppText>
            ) : (
              entries.map((entry, index) => {
                const confirming = confirmDeleteId === entry.id;
                const busy = deletingId === entry.id;
                return (
                  <View key={entry.id} style={index > 0 ? styles.rowBorderTop : undefined}>
                    <View style={styles.row}>
                      <Pill
                        label={formatHours(entry.hours)}
                        bg={colors.sunLight}
                        fg={colors.ink}
                        style={styles.hoursPill}
                      />
                      <View style={styles.rowBody}>
                        <AppText variant="bodyStrong">
                          {isAdmin && entry.employee
                            ? `${entry.employee} · ${formatShortDate(entry.occurred_on)}`
                            : formatShortDate(entry.occurred_on)}
                        </AppText>
                        {entry.description ? (
                          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                            {entry.description}
                          </AppText>
                        ) : null}
                      </View>
                      <AnimatedPressable
                        onPress={() => openEdit(entry)}
                        haptic="tapLight"
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel="Edit hours"
                        style={styles.iconButton}>
                        <Ionicons name="pencil" size={14} color={colors.accentPrimary} />
                      </AnimatedPressable>
                      <AnimatedPressable
                        onPress={() => void pressDelete(entry)}
                        disabled={busy}
                        haptic="tapLight"
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={confirming ? 'Confirm delete' : 'Delete hours'}
                        style={[styles.iconButton, confirming && styles.iconButtonDanger]}>
                        {busy ? (
                          <ActivityIndicator size="small" color={colors.danger} />
                        ) : (
                          <Ionicons
                            name="trash"
                            size={14}
                            color={confirming ? colors.white : colors.textMuted}
                          />
                        )}
                      </AnimatedPressable>
                    </View>
                    {confirming ? (
                      <AppText
                        variant="caption"
                        align="right"
                        color={colors.danger}
                        style={styles.confirmHint}>
                        Tap the trash again to delete.
                      </AppText>
                    ) : null}
                  </View>
                );
              })
            )}

            {entries.length > 0 ? (
              <View style={styles.totalRow}>
                <AppText variant="section" color={colors.accentPrimary}>
                  Logged here
                </AppText>
                <AppText variant="numeric" style={styles.totalValue}>
                  {formatHours(total)}
                </AppText>
              </View>
            ) : null}

            {formOpen ? (
              <Card tone="sunk" style={styles.formArea}>
                {isAdmin && !editingId && employees.length > 0 ? (
                  <>
                    <AppText variant="section" color={colors.textMuted}>
                      {targetEmails.length > 1
                        ? `For — ${targetEmails.length} selected`
                        : 'For — tap more than one to log the same hours for each'}
                    </AppText>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={styles.pickRow}>
                        <Chip
                          label={allSelected ? 'Clear' : 'Everyone'}
                          tone="sun"
                          selected={allSelected}
                          onPress={() =>
                            setTargetEmails(allSelected ? [] : employees.map((o) => o.email))
                          }
                        />
                        {employees.map((option) => (
                          <Chip
                            key={option.email}
                            label={option.name}
                            tone="olive"
                            selected={targetEmails.some(
                              (e) => e.toLowerCase() === option.email.toLowerCase(),
                            )}
                            onPress={() => toggleTarget(option.email)}
                          />
                        ))}
                      </View>
                    </ScrollView>
                  </>
                ) : null}
                <AppText variant="section" color={colors.textMuted}>
                  Hours (e.g. 2 or 2.5)
                </AppText>
                <TextInput
                  style={styles.input}
                  value={hoursText}
                  onChangeText={setHoursText}
                  placeholder="0"
                  placeholderTextColor={colors.textMuted}
                  keyboardType="decimal-pad"
                />
                <AppText variant="section" color={colors.textMuted}>
                  Date (YYYY-MM-DD)
                </AppText>
                <TextInput
                  style={styles.input}
                  value={dateText}
                  onChangeText={setDateText}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <AppText variant="section" color={colors.textMuted}>
                  Note (optional)
                </AppText>
                <TextInput
                  style={styles.input}
                  value={noteText}
                  onChangeText={setNoteText}
                  placeholder="e.g. finished rail teardown"
                  placeholderTextColor={colors.textMuted}
                />
                <View style={styles.formButtons}>
                  <Button
                    label="Cancel"
                    onPress={() => {
                      setFormOpen(false);
                      setEditingId(null);
                    }}
                    variant="ghost"
                    size="sm"
                    disabled={saving}
                  />
                  <Button
                    label={editingId ? 'Save' : 'Log hours'}
                    onPress={() => void save()}
                    loading={saving}
                    size="sm"
                  />
                </View>
              </Card>
            ) : (
              <Button
                label="Log hours"
                onPress={openAdd}
                variant="ghost"
                size="sm"
                icon="add-circle"
                style={styles.addRow}
              />
            )}
          </>
        )}
      </Card>

      {status ? (
        <AppText
          variant="caption"
          align="center"
          color={status.kind === 'error' ? colors.danger : colors.success}>
          {status.message}
        </AppText>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  card: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs + 2,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  hoursPill: {
    minWidth: 52,
    alignItems: 'center',
  },
  rowBody: {
    flex: 1,
    gap: 1,
  },
  iconButton: {
    width: 26,
    height: 26,
    borderRadius: radii.sm,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonDanger: {
    backgroundColor: colors.danger,
  },
  confirmHint: {
    paddingBottom: spacing.xs,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.xs + 2,
  },
  totalValue: {
    fontSize: 16,
    lineHeight: 21,
  },
  formArea: {
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.textPrimary,
    ...typography.body,
  },
  formButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  pickRow: {
    flexDirection: 'row',
    gap: spacing.xs,
    paddingVertical: spacing.xs,
  },
  addRow: {
    paddingHorizontal: 0,
  },
});
