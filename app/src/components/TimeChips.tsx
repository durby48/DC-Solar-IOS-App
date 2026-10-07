import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { formatTimeLabel, parseTimeInput } from '@/lib/time';

/**
 * Type a time of day (2026-10-08) — for tasks and appointments. One box;
 * reads "2:30 pm", "230pm", "14:30", "9" (see `parseTimeInput`) and shows
 * how it read it. The value is "HH:MM" (24h) or null; an empty box is null
 * when `optional` (appointments: no time), otherwise the last good time is
 * kept. (Was a row of hour chips — too many bubbles, Carson.)
 */
export function TimeChips({
  value,
  onChange,
  optional = false,
}: {
  value: string | null;
  onChange: (next: string | null) => void;
  /** An empty box means "no time". */
  optional?: boolean;
}) {
  const [text, setText] = useState(value ? (formatTimeLabel(value) ?? '') : '');
  const parsed = text.trim() ? parseTimeInput(text) : null;

  return (
    <View style={styles.row}>
      <TextInput
        value={text}
        onChangeText={(t) => {
          setText(t);
          if (!t.trim()) {
            if (optional) onChange(null);
            return;
          }
          const p = parseTimeInput(t);
          if (p) onChange(p);
        }}
        onBlur={() => {
          if (parsed) setText(formatTimeLabel(parsed) ?? text);
        }}
        placeholder={optional ? 'No time' : '9:00 AM'}
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Text style={[styles.hint, text.trim() && !parsed && styles.bad]}>
        {!text.trim()
          ? optional
            ? 'Type a time, or leave it blank'
            : 'Type a time, like 2:30 pm'
          : parsed
            ? formatTimeLabel(parsed)
            : 'Type it like 2:30 pm'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  input: {
    width: 120,
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
  hint: { flex: 1, color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  bad: { color: colors.danger },
});
