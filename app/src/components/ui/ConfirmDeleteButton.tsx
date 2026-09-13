import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';

/**
 * A permanent-delete control that needs two taps (2026-09-13).
 *
 * First tap arms it ("Tap again to delete permanently"); the second runs
 * `onConfirm`. It disarms itself after a few seconds, so a stray tap never
 * leaves a loaded trigger on screen. The same two-tap pattern the app already
 * uses for Archive, photo delete and ledger rows — no modal, works on web.
 */
export function ConfirmDeleteButton({
  label,
  onConfirm,
  busy = false,
  style,
}: {
  /** "Delete customer", "Delete contact". */
  label: string;
  onConfirm: () => void;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 5000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Pressable
      onPress={() => {
        if (busy) return;
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
      disabled={busy}
      accessibilityRole="button"
      accessibilityLabel={armed ? `${label}: tap again to confirm` : label}
      style={({ pressed }) => [styles.button, armed && styles.armed, pressed && styles.pressed, style]}>
      {busy ? (
        <ActivityIndicator size="small" color={colors.danger} />
      ) : (
        <Ionicons name="trash-outline" size={16} color={armed ? colors.textInverse : colors.danger} />
      )}
      <Text style={[styles.text, armed && styles.textArmed]}>
        {armed ? 'Tap again to delete permanently' : label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  armed: { backgroundColor: colors.danger },
  text: { color: colors.danger, fontSize: 13, fontWeight: '800' },
  textArmed: { color: colors.textInverse },
  pressed: { opacity: 0.7 },
});
