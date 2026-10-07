import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { formatTimeLabel, parseTimeInput } from '@/lib/time';

/**
 * Pick a time of day in one tap (2026-10-08) — for tasks and appointments.
 * Quick chips 8 AM – 5 PM, "Other…" for anything else (types "2:30 pm",
 * "14:30", "9"), and optionally "No time". The value is "HH:MM" (24h) or
 * null.
 */
const QUICK = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];

export function TimeChips({
  value,
  onChange,
  noneLabel,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  /** Show a "no time" chip with this label (appointments: "No time"). */
  noneLabel?: string;
}) {
  const custom = value !== null && !QUICK.includes(value);
  const [otherOpen, setOtherOpen] = useState(custom);
  const [text, setText] = useState(custom && value ? (formatTimeLabel(value) ?? '') : '');
  const parsed = text ? parseTimeInput(text) : null;

  return (
    <View style={styles.box}>
      <View style={styles.chips}>
        {noneLabel ? (
          <Chip
            label={noneLabel}
            tone="neutral"
            selected={value === null}
            onPress={() => {
              setOtherOpen(false);
              onChange(null);
            }}
          />
        ) : null}
        {QUICK.map((t) => (
          <Chip
            key={t}
            label={(formatTimeLabel(t) ?? t).replace(':00', '')}
            tone="ocean"
            selected={value === t && !otherOpen}
            onPress={() => {
              setOtherOpen(false);
              onChange(t);
            }}
          />
        ))}
        <Chip label="Other…" tone="ocean" selected={otherOpen} onPress={() => setOtherOpen(true)} />
      </View>
      {otherOpen ? (
        <View style={styles.otherRow}>
          <TextInput
            value={text}
            onChangeText={(t) => {
              setText(t);
              const p = parseTimeInput(t);
              if (p) onChange(p);
            }}
            placeholder="2:30 pm"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            style={styles.input}
          />
          <Text style={[styles.hint, text && !parsed && styles.bad]}>
            {text ? (parsed ? formatTimeLabel(parsed) : 'Type it like 2:30 pm') : 'Any time, like 7:45 am'}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  otherRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    width: 110,
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  bad: { color: colors.danger },
});
