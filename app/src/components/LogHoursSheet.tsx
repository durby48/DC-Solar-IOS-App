import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';

import { AnimatedPressable, AppText, Button, Card, Chip } from '@/components/ui';
import { colors, hubColors, radii, spacing, typography } from '@/constants/theme';
import { todayISO } from '@/lib/dates';
import { haptics } from '@/lib/haptics';
import {
  addMyHoursForMany,
  fetchEmployeeOptions,
  fetchJobOptions,
  type AddManyHoursResult,
  type EmployeeOption,
  type JobOption,
} from '@/lib/myhours';
import { isValidISODate } from '@/lib/time';

/** Jobs above this count get a search box over the chip row. */
const JOB_SEARCH_THRESHOLD = 8;
const HOUR_PRESETS = [4, 6, 8, 10] as const;
const hr = hubColors.hr;

function formatHours(h: number): string {
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** What `onSaved` receives: the DB outcome plus what was asked for. */
export type LogHoursOutcome = AddManyHoursResult & {
  hours: number;
  occurredOn: string;
  jobId: string;
};

/**
 * One form that logs the SAME hours for any number of people in one save.
 *
 * Devon's ask: "only putting 5 hours but clicking that Ben, Isaiah and Simon
 * worked them and only submit it once" — so the people picker is a
 * multi-select of checkbox rows, not a single choice, and Save inserts one
 * employee_hours row per ticked person (`addMyHoursForMany`). One ticked row
 * is the ordinary single-person log; nothing else changes.
 *
 * Reused from two places, which is why the job and the people are both
 * optional inputs:
 *   - the Hours tab: no job known → shows the job picker (search box once
 *     the list is long), and every real (non-test) employee unticked.
 *   - a job screen: `jobId` fixed → no picker; admins get the roster with
 *     `defaultEmails` pre-ticked, crew get `lockedEmail` and no roster at all.
 *
 * Partial failure: if some rows could not be saved the sheet stays open and
 * lists each person with a tick or a cross, so the admin knows exactly which
 * entries exist. The parent still gets `onSaved` (to refresh totals) and
 * should close the sheet only when `outcome.ok`.
 */
export function LogHoursSheet({
  jobId,
  lockedEmail,
  defaultEmails,
  title,
  onSaved,
  onCancel,
}: {
  /** Fix the job (hides the picker). */
  jobId?: string;
  /** Crew mode: log for this one person only, no roster shown. */
  lockedEmail?: string;
  /** Admin mode: people ticked when the sheet opens. */
  defaultEmails?: string[];
  title?: string;
  /** Fired whenever at least one row landed. Close the sheet when `ok`. */
  onSaved?: (outcome: LogHoursOutcome) => void;
  onCancel?: () => void;
}) {
  const pickPeople = !lockedEmail;
  const pickJob = !jobId;

  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [selected, setSelected] = useState<string[]>(
    lockedEmail ? [lockedEmail] : (defaultEmails ?? []),
  );
  const [jobs, setJobs] = useState<JobOption[]>([]);
  const [jobSearch, setJobSearch] = useState('');
  const [selectedJobId, setSelectedJobId] = useState<string | null>(jobId ?? null);
  const [hoursText, setHoursText] = useState('');
  const [dateText, setDateText] = useState(todayISO());
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<LogHoursOutcome | null>(null);

  useEffect(() => {
    if (pickPeople) fetchEmployeeOptions().then(setEmployees);
  }, [pickPeople]);

  useEffect(() => {
    if (pickJob) fetchJobOptions().then(setJobs);
  }, [pickJob]);

  const isSelected = (email: string) =>
    selected.some((e) => e.toLowerCase() === email.toLowerCase());

  const togglePerson = (email: string) => {
    setOutcome(null);
    setSelected((current) =>
      current.some((e) => e.toLowerCase() === email.toLowerCase())
        ? current.filter((e) => e.toLowerCase() !== email.toLowerCase())
        : [...current, email],
    );
  };

  const allSelected = employees.length > 0 && selected.length >= employees.length;

  const filteredJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) =>
      [job.job_number, job.name, job.customerName, job.address].some((field) =>
        field?.toLowerCase().includes(q),
      ),
    );
  }, [jobs, jobSearch]);

  const nameFor = (email: string) =>
    employees.find((e) => e.email.toLowerCase() === email.toLowerCase())?.name ?? email;

  const save = async () => {
    const hours = Number(hoursText.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24) {
      setError('Enter hours between 0 and 24 (e.g. 2 or 2.5).');
      return;
    }
    const day = dateText.trim();
    if (!isValidISODate(day)) {
      setError('Enter the date as YYYY-MM-DD (e.g. 2026-09-12).');
      return;
    }
    if (!selectedJobId) {
      setError('Pick the job these hours were worked on.');
      return;
    }
    if (selected.length === 0) {
      setError('Tick at least one person.');
      return;
    }
    setSaving(true);
    setError(null);
    setOutcome(null);
    const result = await addMyHoursForMany({
      jobId: selectedJobId,
      emails: selected,
      hours,
      occurredOn: day,
      note: noteText.trim() || null,
    });
    setSaving(false);
    const full: LogHoursOutcome = { ...result, hours, occurredOn: day, jobId: selectedJobId };
    if (result.ok) {
      haptics.success();
      onSaved?.(full);
      return;
    }
    if (result.inserted > 0) {
      // Some landed: show who did and who did not, and let the parent
      // refresh its totals for the rows that exist.
      haptics.warn();
      setOutcome(full);
      onSaved?.(full);
    } else {
      haptics.error();
      setError(result.message);
    }
  };

  const peopleCount = selected.length;
  const saveLabel =
    peopleCount > 1 ? `Log hours for ${peopleCount} people` : 'Log hours';

  return (
    <Card tone="sunk" style={styles.sheet}>
      <View style={styles.titleRow}>
        <View style={[styles.titleIcon, { backgroundColor: hr.bg }]}>
          <Ionicons name="time" size={16} color={hr.fg} />
        </View>
        <AppText variant="heading" style={styles.titleText}>
          {title ?? 'Log hours'}
        </AppText>
      </View>

      {pickPeople ? (
        <View style={styles.block}>
          <View style={styles.blockHeader}>
            <AppText variant="section" color={colors.textMuted}>
              {peopleCount > 0 ? `Who — ${peopleCount} selected` : 'Who — tick everyone who worked'}
            </AppText>
            {employees.length > 1 ? (
              <AnimatedPressable
                onPress={() => {
                  setOutcome(null);
                  setSelected(allSelected ? [] : employees.map((o) => o.email));
                }}
                haptic="tapLight"
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={allSelected ? 'Clear everyone' : 'Select everyone'}>
                <AppText variant="caption" color={hr.deep}>
                  {allSelected ? 'Clear' : 'Everyone'}
                </AppText>
              </AnimatedPressable>
            ) : null}
          </View>
          {employees.length === 0 ? (
            <AppText variant="caption" color={colors.textMuted}>
              Loading the roster…
            </AppText>
          ) : (
            <View style={styles.personList}>
              {employees.map((option, index) => {
                const on = isSelected(option.email);
                return (
                  <AnimatedPressable
                    key={option.email}
                    onPress={() => togglePerson(option.email)}
                    disabled={saving}
                    haptic="tapLight"
                    scaleTo={0.985}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on, disabled: saving }}
                    accessibilityLabel={option.name}
                    style={({ pressed }) => [
                      styles.personRow,
                      index > 0 && styles.personRowBorder,
                      on && { backgroundColor: hr.bg },
                      pressed && styles.personRowPressed,
                    ]}>
                    <Ionicons
                      name={on ? 'checkbox' : 'square-outline'}
                      size={22}
                      color={on ? hr.fg : colors.borderStrong}
                    />
                    <AppText
                      variant={on ? 'bodyStrong' : 'body'}
                      color={on ? hr.deep : colors.textPrimary}
                      style={styles.personName}
                      numberOfLines={1}>
                      {option.name}
                    </AppText>
                  </AnimatedPressable>
                );
              })}
            </View>
          )}
        </View>
      ) : null}

      {pickJob ? (
        <View style={styles.block}>
          <AppText variant="section" color={colors.textMuted}>
            Job
          </AppText>
          {jobs.length > JOB_SEARCH_THRESHOLD ? (
            <TextInput
              value={jobSearch}
              onChangeText={setJobSearch}
              placeholder="Search job, customer or address"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
            />
          ) : null}
          {jobs.length === 0 ? (
            <AppText variant="caption" color={colors.textMuted}>
              Loading jobs…
            </AppText>
          ) : (
            <View style={styles.chipWrap}>
              {filteredJobs.map((job) => (
                <Chip
                  key={job.id}
                  label={job.job_number ?? job.name}
                  tone="success"
                  selected={selectedJobId === job.id}
                  onPress={() => {
                    setOutcome(null);
                    setSelectedJobId(job.id);
                  }}
                />
              ))}
              {filteredJobs.length === 0 ? (
                <AppText variant="caption" color={colors.textMuted}>
                  No jobs match &quot;{jobSearch.trim()}&quot;.
                </AppText>
              ) : null}
            </View>
          )}
          {selectedJobId ? (
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {(() => {
                const job = jobs.find((j) => j.id === selectedJobId);
                if (!job) return ' ';
                return [job.customerName, job.address].filter(Boolean).join(' · ') || job.name;
              })()}
            </AppText>
          ) : null}
        </View>
      ) : null}

      <View style={styles.block}>
        <AppText variant="section" color={colors.textMuted}>
          Hours (each person)
        </AppText>
        <View style={styles.hoursRow}>
          <TextInput
            value={hoursText}
            onChangeText={setHoursText}
            placeholder="0"
            placeholderTextColor={colors.textMuted}
            keyboardType="decimal-pad"
            style={[styles.input, styles.hoursInput]}
          />
          {HOUR_PRESETS.map((preset) => (
            <Chip
              key={preset}
              label={`${preset}`}
              tone="neutral"
              selected={Number(hoursText) === preset}
              onPress={() => setHoursText(String(preset))}
            />
          ))}
        </View>
      </View>

      <View style={styles.block}>
        <AppText variant="section" color={colors.textMuted}>
          Date (YYYY-MM-DD)
        </AppText>
        <View style={styles.hoursRow}>
          <TextInput
            value={dateText}
            onChangeText={setDateText}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, styles.dateInput]}
          />
          <Chip
            label="Today"
            tone="neutral"
            selected={dateText === todayISO()}
            onPress={() => setDateText(todayISO())}
          />
          <Chip
            label="Yesterday"
            tone="neutral"
            selected={dateText === isoDaysAgo(1)}
            onPress={() => setDateText(isoDaysAgo(1))}
          />
        </View>
      </View>

      <View style={styles.block}>
        <AppText variant="section" color={colors.textMuted}>
          Note (optional)
        </AppText>
        <TextInput
          value={noteText}
          onChangeText={setNoteText}
          placeholder="e.g. finished rail teardown"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
        />
      </View>

      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}

      {outcome ? (
        <View style={styles.outcome}>
          {!outcome.ok ? (
            <AppText variant="caption" color={colors.danger}>
              {outcome.message}
            </AppText>
          ) : null}
          {outcome.rows.map((row) => (
            <View key={row.email} style={styles.outcomeRow}>
              <Ionicons
                name={row.ok ? 'checkmark-circle' : 'close-circle'}
                size={16}
                color={row.ok ? colors.success : colors.danger}
              />
              <AppText variant="caption" style={styles.outcomeText} numberOfLines={2}>
                {row.ok
                  ? `${nameFor(row.email)} — ${formatHours(outcome.hours)} saved`
                  : `${nameFor(row.email)} — ${row.message ?? 'not saved'}`}
              </AppText>
            </View>
          ))}
          <AppText variant="caption" color={colors.textMuted}>
            Untick the people already saved and try again for the rest.
          </AppText>
        </View>
      ) : null}

      <View style={styles.buttons}>
        {onCancel ? (
          <Button label="Cancel" variant="ghost" size="sm" onPress={onCancel} disabled={saving} />
        ) : null}
        <Button label={saveLabel} size="sm" icon="checkmark" loading={saving} onPress={() => void save()} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  sheet: {
    gap: spacing.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  titleIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleText: {
    flex: 1,
  },
  block: {
    gap: spacing.xs,
  },
  blockHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  personList: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    minHeight: 44,
  },
  personRowBorder: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  personRowPressed: {
    opacity: 0.8,
  },
  personName: {
    flex: 1,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
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
  hoursRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  hoursInput: {
    width: 84,
  },
  dateInput: {
    width: 136,
  },
  outcome: {
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.xs,
  },
  outcomeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  outcomeText: {
    flex: 1,
  },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
});
