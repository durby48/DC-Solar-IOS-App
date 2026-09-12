import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { saveMyCellPhone } from '@/lib/comms';

/**
 * A crew member's own cell number, edited from their row in the directory.
 *
 * `staff_profiles` is self-write only, so this is the ONE field on a crew
 * row anyone can change from here, and only on their own row. It is the
 * number Twilio rings first for a bridge call — the same field the Keypad
 * asks for on the first Call.
 */
export function MyCellEditor({
  initial,
  onSaved,
  onCancel,
}: {
  initial: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    setSaving(true);
    const result = await saveMyCellPhone(value.trim() || null);
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved();
  };

  return (
    <View style={styles.form}>
      <Text style={styles.hint}>
        The phone we ring first when you place a call. Customers only ever see the DC Solar number.
      </Text>
      <TextInput
        value={value}
        onChangeText={setValue}
        placeholder="(816) 555-0100"
        placeholderTextColor={colors.inkSoft}
        keyboardType="phone-pad"
        autoFocus
        style={styles.input}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => void save()}
          disabled={saving}
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? <ActivityIndicator color={colors.ink} size="small" /> : <Text style={styles.saveText}>Save</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.sm },
  hint: { color: colors.inkSoft, fontSize: 13, fontWeight: '600' },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
  },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  save: {
    backgroundColor: colors.sun,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    minWidth: 72,
    alignItems: 'center',
  },
  saveText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
