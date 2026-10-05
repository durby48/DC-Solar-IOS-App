import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { fetchAvailableNumbers, type AvailableNumber } from '@/lib/employeeInvites';

/**
 * Pick one of DC Solar's Twilio numbers that nobody has yet (2026-10-05) —
 * the invite form and the Phone numbers card. The list is read live from
 * Twilio minus everything already in voice_routes, so a number disappears
 * once it is assigned and a newly bought one just shows up. A number that is
 * only half set up in Twilio says so (texts would fail with 30034 / calls
 * would not reach the app). When none are left it says how to get more.
 */
export function NumberDropdown({
  value,
  onChange,
  allowNone = true,
}: {
  value: string | null;
  onChange: (number: string | null) => void;
  /** Show a "No number" option (the invite form: a number is optional). */
  allowNone?: boolean;
}) {
  const [numbers, setNumbers] = useState<AvailableNumber[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchAvailableNumbers().then((result) => {
      if (cancelled) return;
      if (result.ok) setNumbers(result.numbers);
      else setError(result.message);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) return <Text style={styles.error}>{error}</Text>;
  if (numbers === null) {
    return (
      <View style={styles.field}>
        <ActivityIndicator size="small" color={colors.ocean} />
        <Text style={styles.muted}>Checking DC Solar's numbers…</Text>
      </View>
    );
  }
  if (numbers.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>All DC Solar numbers are assigned</Text>
        <Text style={styles.muted}>
          To give someone their own number, buy another in Twilio (Phone Numbers → Buy a number, 816 area code), add it to
          the DC Solar Messaging Service, and set its "A call comes in" webhook to the same address as the main number. It
          will then show up here.
        </Text>
      </View>
    );
  }

  const selected = numbers.find((n) => n.number === value) ?? null;
  const warn = (n: AvailableNumber) =>
    [!n.texting_ready ? 'texting not set up in Twilio' : null, !n.calls_ready ? 'calls not set up in Twilio' : null]
      .filter(Boolean)
      .join(' · ');

  return (
    <View>
      <Pressable onPress={() => setOpen((v) => !v)} style={({ pressed }) => [styles.field, pressed && styles.dim]}>
        <Ionicons name="call-outline" size={16} color={colors.ocean} />
        <Text style={[styles.value, !selected && styles.muted]}>
          {selected ? formatPhone(selected.number) : 'No DC Solar number'}
        </Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
      </Pressable>
      {open ? (
        <View style={styles.list}>
          {allowNone ? (
            <Pressable
              onPress={() => {
                onChange(null);
                setOpen(false);
              }}
              style={({ pressed }) => [styles.option, pressed && styles.dim]}>
              <Text style={styles.muted}>No DC Solar number</Text>
            </Pressable>
          ) : null}
          {numbers.map((n) => (
            <Pressable
              key={n.number}
              onPress={() => {
                onChange(n.number);
                setOpen(false);
              }}
              style={({ pressed }) => [styles.option, pressed && styles.dim]}>
              <View style={styles.optionBody}>
                <Text style={styles.value}>{formatPhone(n.number)}</Text>
                {warn(n) ? <Text style={styles.warn}>⚠ {warn(n)}</Text> : null}
              </View>
              {n.number === value ? <Ionicons name="checkmark" size={16} color={colors.olive} /> : null}
            </Pressable>
          ))}
        </View>
      ) : null}
      {selected && warn(selected) ? <Text style={styles.warn}>⚠ This number's {warn(selected)} — finish that before they use it.</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  value: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '700' },
  muted: { color: colors.inkSoft, fontSize: 13, fontWeight: '500' },
  list: { marginTop: spacing.xs, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface },
  option: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm + 2, borderBottomWidth: 1, borderBottomColor: colors.line },
  optionBody: { flex: 1, gap: 2 },
  warn: { color: colors.amberDeep, fontSize: 12, fontWeight: '700' },
  empty: { gap: spacing.xs, padding: spacing.sm, borderRadius: radii.sm, backgroundColor: colors.amberSoft },
  emptyTitle: { color: colors.amberDeep, fontSize: 13, fontWeight: '800' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  dim: { opacity: 0.6 },
});
