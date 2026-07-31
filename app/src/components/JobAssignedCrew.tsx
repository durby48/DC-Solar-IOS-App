import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
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
      <Text style={styles.sectionTitle}>Assigned crew</Text>
      <View style={styles.card}>
        {isAdmin ? (
          <>
            <View style={styles.chipWrap}>
              {employees.map((option) => {
                const on = isAssigned(option.email);
                const busy = busyEmail === option.email;
                return (
                  <Pressable
                    key={option.email}
                    onPress={() => void toggle(option)}
                    disabled={busyEmail !== null}
                    style={[styles.chip, on && styles.chipOn]}>
                    {busy ? (
                      <ActivityIndicator
                        size="small"
                        color={on ? colors.white : colors.ocean}
                      />
                    ) : (
                      <>
                        <Ionicons
                          name={on ? 'checkmark-circle' : 'add-circle-outline'}
                          size={14}
                          color={on ? colors.white : colors.ocean}
                        />
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>
                          {option.name}
                        </Text>
                      </>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <Text style={styles.hint}>Tap a name to assign or remove them.</Text>
          </>
        ) : assigned.length > 0 ? (
          <View style={styles.chipWrap}>
            {assigned.map((a) => (
              <View key={a.email} style={[styles.chip, styles.chipOn]}>
                <Ionicons name="person" size={13} color={colors.white} />
                <Text style={[styles.chipText, styles.chipTextOn]}>{a.name}</Text>
              </View>
            ))}
          </View>
        ) : (
          <Text style={styles.hint}>No crew assigned yet.</Text>
        )}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </View>
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
    gap: spacing.sm,
    ...shadows.card,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    minHeight: 28,
  },
  chipOn: {
    backgroundColor: colors.ocean,
  },
  chipText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
  },
  chipTextOn: {
    color: colors.white,
  },
  hint: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: '600',
  },
});
