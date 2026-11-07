/**
 * Inline editor for ONE hour entry on the Hours tab (admins, 2026-11-07).
 *
 * Logged hours (employee_hours): hours, date, job, note.
 * Clock shifts (time_entries): date, clock-in, clock-out, job, note. An open
 * punch (still clocked in) gets the same form with clock-out blank, so a
 * forgotten clock-out can be closed at the real time.
 *
 * Delete is two taps on the same button (no system dialog — those block the
 * web build and are easy to fat-finger through on a phone).
 */

import { useMemo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { AppText, Button, Chip } from '@/components/ui';
import { colors, radii, spacing, typography } from '@/constants/theme';
import {
  deleteClockShift,
  deleteLoggedHours,
  updateClockShift,
  updateLoggedHours,
  zonedDate,
  zonedTime,
  zonedToIso,
} from '@/lib/hoursAdmin';
import { type JobOption } from '@/lib/myhours';
import { isValidISODate } from '@/lib/time';

const MAX_JOB_CHIPS = 8;

export type EditableHourEntry =
  | {
      kind: 'logged';
      id: string;
      hours: number;
      date: string;
      jobId: string | null;
      note: string | null;
    }
  | {
      kind: 'clock';
      id: string;
      clockIn: string;
      /** Null = still clocked in. */
      clockOut: string | null;
      jobId: string | null;
      note: string | null;
    };

export function HourEntryEditor({
  entry,
  jobs,
  editorEmail,
  onDone,
  onCancel,
}: {
  entry: EditableHourEntry;
  jobs: JobOption[];
  /** Stamped as time_entries.edited_by. */
  editorEmail: string | null;
  /** After a successful save or delete. */
  onDone: (what: 'saved' | 'deleted') => void;
  onCancel: () => void;
}) {
  const [hoursText, setHoursText] = useState(entry.kind === 'logged' ? String(entry.hours) : '');
  const [dateText, setDateText] = useState(entry.kind === 'logged' ? entry.date : zonedDate(entry.clockIn));
  const [inText, setInText] = useState(entry.kind === 'clock' ? zonedTime(entry.clockIn) : '');
  const [outText, setOutText] = useState(
    entry.kind === 'clock' && entry.clockOut ? zonedTime(entry.clockOut) : '',
  );
  // A shift that ran past midnight ends on a later day; edit that day too.
  const [outDateText, setOutDateText] = useState(
    entry.kind === 'clock' && entry.clockOut ? zonedDate(entry.clockOut) : '',
  );
  const [jobId, setJobId] = useState<string | null>(entry.jobId);
  const [jobSearch, setJobSearch] = useState('');
  const [noteText, setNoteText] = useState(entry.note ?? '');
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentJob = jobs.find((j) => j.id === jobId) ?? null;
  const jobChips = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    const list = q
      ? jobs.filter((job) =>
          [job.job_number, job.name, job.customerName, job.address].some((f) => f?.toLowerCase().includes(q)),
        )
      : jobs.filter((j) => j.id !== jobId);
    return list.slice(0, MAX_JOB_CHIPS);
  }, [jobs, jobSearch, jobId]);

  const save = async () => {
    setError(null);
    if (!isValidISODate(dateText.trim())) {
      setError('Date must be YYYY-MM-DD.');
      return;
    }
    const note = noteText.trim() || null;
    setBusy('save');
    let result;
    if (entry.kind === 'logged') {
      const hours = Number(hoursText.replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
        setBusy(null);
        setError('Hours must be more than 0 and at most 24.');
        return;
      }
      result = await updateLoggedHours(entry.id, { hours, occurredOn: dateText.trim(), jobId, note });
    } else {
      const clockIn = zonedToIso(dateText, inText);
      if (!clockIn) {
        setBusy(null);
        setError('Clock-in must be a time like 7:30 AM or 19:30.');
        return;
      }
      let clockOut: string | null = null;
      if (outText.trim()) {
        const outDate = outDateText.trim() || dateText.trim();
        if (!isValidISODate(outDate)) {
          setBusy(null);
          setError('Clock-out date must be YYYY-MM-DD.');
          return;
        }
        clockOut = zonedToIso(outDate, outText);
        if (!clockOut) {
          setBusy(null);
          setError('Clock-out must be a time like 3:30 PM or 15:30.');
          return;
        }
        const hours = (new Date(clockOut).getTime() - new Date(clockIn).getTime()) / 3_600_000;
        if (hours <= 0) {
          setBusy(null);
          setError('Clock-out has to be after clock-in. For an overnight shift, set the clock-out date.');
          return;
        }
        if (hours > 24) {
          setBusy(null);
          setError('That shift is longer than 24 hours — check the dates.');
          return;
        }
      }
      result = await updateClockShift(entry.id, { clockIn, clockOut, jobId, note, editedBy: editorEmail });
    }
    setBusy(null);
    if (result.ok) onDone('saved');
    else setError(result.message);
  };

  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setError(null);
    setBusy('delete');
    const result = entry.kind === 'logged' ? await deleteLoggedHours(entry.id) : await deleteClockShift(entry.id);
    setBusy(null);
    if (result.ok) onDone('deleted');
    else {
      setConfirmDelete(false);
      setError(result.message);
    }
  };

  const previewHours = (() => {
    if (entry.kind !== 'clock' || !outText.trim()) return null;
    const a = zonedToIso(dateText, inText);
    const b = zonedToIso(outDateText.trim() || dateText.trim(), outText);
    if (!a || !b) return null;
    const h = (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
    return h > 0 ? `${Math.round(h * 100) / 100} h` : null;
  })();

  return (
    <View style={styles.editor}>
      {entry.kind === 'logged' ? (
        <View style={styles.row}>
          <Field label="Hours" style={styles.narrow}>
            <TextInput
              value={hoursText}
              onChangeText={setHoursText}
              keyboardType="decimal-pad"
              style={styles.input}
              placeholderTextColor={colors.textMuted}
            />
          </Field>
          <Field label="Date" style={styles.flex}>
            <TextInput
              value={dateText}
              onChangeText={setDateText}
              placeholder="YYYY-MM-DD"
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              placeholderTextColor={colors.textMuted}
            />
          </Field>
        </View>
      ) : (
        <>
          <View style={styles.row}>
            <Field label="Date" style={styles.flex}>
              <TextInput
                value={dateText}
                onChangeText={setDateText}
                placeholder="YYYY-MM-DD"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                placeholderTextColor={colors.textMuted}
              />
            </Field>
            <Field label="Clock in" style={styles.flex}>
              <TextInput
                value={inText}
                onChangeText={setInText}
                placeholder="7:30 AM"
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.input}
                placeholderTextColor={colors.textMuted}
              />
            </Field>
          </View>
          <View style={styles.row}>
            <Field label="Clock out" style={styles.flex}>
              <TextInput
                value={outText}
                onChangeText={setOutText}
                placeholder={entry.clockOut ? '3:30 PM' : 'Still clocked in'}
                autoCapitalize="characters"
                autoCorrect={false}
                style={styles.input}
                placeholderTextColor={colors.textMuted}
              />
            </Field>
            <Field label="Out date (if different)" style={styles.flex}>
              <TextInput
                value={outDateText}
                onChangeText={setOutDateText}
                placeholder={dateText || 'YYYY-MM-DD'}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
                placeholderTextColor={colors.textMuted}
              />
            </Field>
          </View>
          <AppText variant="caption" color={colors.textMuted}>
            Kansas City time.{previewHours ? ` Shift: ${previewHours}.` : ''}
            {!entry.clockOut && !outText.trim() ? ' Leave clock-out blank to keep them clocked in.' : ''}
          </AppText>
        </>
      )}

      <Field label="Job">
        <View style={styles.chips}>
          <Chip
            label={currentJob ? (currentJob.job_number ?? currentJob.name) : 'No job'}
            tone="success"
            selected
            onPress={() => {}}
          />
          {jobId ? <Chip label="No job" tone="neutral" onPress={() => setJobId(null)} /> : null}
        </View>
        <TextInput
          value={jobSearch}
          onChangeText={setJobSearch}
          placeholder="Change job — search number, customer or address"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {jobSearch.trim() ? (
          <View style={styles.chips}>
            {jobChips.map((job) => (
              <Chip
                key={job.id}
                label={job.job_number ?? job.name}
                tone="success"
                selected={job.id === jobId}
                onPress={() => {
                  setJobId(job.id);
                  setJobSearch('');
                }}
              />
            ))}
            {jobChips.length === 0 ? (
              <AppText variant="caption" color={colors.textMuted}>
                No jobs match.
              </AppText>
            ) : null}
          </View>
        ) : null}
      </Field>

      <Field label="Note">
        <TextInput
          value={noteText}
          onChangeText={setNoteText}
          placeholder="Why it changed (optional)"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />
      </Field>

      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}

      <View style={styles.buttons}>
        <Button
          label={confirmDelete ? 'Tap again to delete' : 'Delete'}
          variant="danger"
          size="sm"
          icon="trash"
          loading={busy === 'delete'}
          disabled={busy !== null}
          onPress={() => void remove()}
        />
        <View style={styles.flex} />
        <Button label="Cancel" variant="ghost" size="sm" disabled={busy !== null} onPress={onCancel} />
        <Button
          label="Save"
          size="sm"
          icon="checkmark"
          loading={busy === 'save'}
          disabled={busy !== null}
          onPress={() => void save()}
        />
      </View>
    </View>
  );
}

function Field({
  label,
  style,
  children,
}: {
  label: string;
  style?: object;
  children: React.ReactNode;
}) {
  return (
    <View style={[styles.field, style]}>
      <AppText variant="section" color={colors.textMuted}>
        {label}
      </AppText>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  editor: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  field: {
    gap: spacing.xs,
  },
  flex: {
    flex: 1,
  },
  narrow: {
    width: 90,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  input: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm - 2,
    color: colors.textPrimary,
    ...typography.body,
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
});
