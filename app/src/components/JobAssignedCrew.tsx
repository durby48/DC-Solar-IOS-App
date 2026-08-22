import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { AppText, Card, Chip, SectionHeader } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import {
  assignToJob,
  fetchAssignmentsByJob,
  unassignFromJob,
  type Assignment,
} from '@/lib/assignments';
import { fetchEmployeeOptions, type EmployeeOption } from '@/lib/myhours';

/**
 * Assigned crew for a job. Everyone sees who's expected on the job;
 * admins tap employee chips to assign/unassign (filled chip = assigned).
 *
 * 2026-08-22 restyle: the hand-rolled chips are `Chip tone="olive"` now, whose
 * selected state is a FILL change rather than an outline — the same thing the
 * old `chipOn` style did, just from the kit. The in-flight chip swaps its
 * icon for a sync glyph instead of hosting a spinner; every chip is disabled
 * while a write is in the air, exactly as before.
 */
export function JobAssignedCrew({ jobId, isAdmin }: { jobId: string; isAdmin: boolean }) {
  const [assigned, setAssigned] = useState<Assignment[] | null>(null);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [busyEmail, setBusyEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const map = await fetchAssignmentsByJob();
    setAssigned(map ? (map.get(jobId) ?? []) : null);
  }, [jobId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isAdmin) return;
    fetchEmployeeOptions().then(setEmployees);
  }, [isAdmin]);

  if (assigned === null) return null; // pre-migration / offline — hide quietly

  const isAssigned = (email: string) => assigned.some((a) => a.email === email);

  const toggle = async (option: EmployeeOption) => {
    if (busyEmail) return;
    setError(null);
    setBusyEmail(option.email);
    const result = isAssigned(option.email)
      ? await unassignFromJob(jobId, option.email)
      : await assignToJob(jobId, option.email);
    setBusyEmail(null);
    if (result.ok) {
      await load();
    } else {
      setError(result.message);
    }
  };

  return (
    <>
      <SectionHeader title="Assigned crew" icon="people" style={styles.section} />
      <Card style={styles.card}>
        {isAdmin ? (
          <>
            <View style={styles.chipWrap}>
              {employees.map((option) => {
                const on = isAssigned(option.email);
                const busy = busyEmail === option.email;
                return (
                  <Chip
                    key={option.email}
                    label={option.name}
                    tone="olive"
                    selected={on}
                    icon={busy ? 'sync' : on ? 'checkmark-circle' : 'add-circle-outline'}
                    disabled={busyEmail !== null}
                    onPress={() => void toggle(option)}
                  />
                );
              })}
            </View>
            <AppText variant="caption" color={colors.textMuted}>
              Tap a name to assign or remove them.
            </AppText>
          </>
        ) : assigned.length > 0 ? (
          <View style={styles.chipWrap}>
            {assigned.map((a) => (
              <Chip key={a.email} label={a.name} tone="olive" selected icon="person" />
            ))}
          </View>
        ) : (
          <AppText variant="caption" color={colors.textMuted}>
            No crew assigned yet.
          </AppText>
        )}
        {error ? (
          <AppText variant="caption" color={colors.danger}>
            {error}
          </AppText>
        ) : null}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm,
  },
  card: {
    gap: spacing.sm,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
});
