import { StyleSheet, TextInput, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';

/**
 * A labelled text input for the money screens.
 *
 * There is no `Input` in `components/ui` yet — the kit deliberately shipped
 * without one, because a text field is the one control whose keyboard type,
 * autocorrect and formatting differ at nearly every call site. So the shared
 * part is just this: the uppercase eyebrow label from `AppText variant
 * "section"` over a sunk box with a real border, which is the pattern
 * `cards/editor.tsx` established for restyled forms.
 */
export function Field({
  label,
  value,
  onChangeText,
  placeholder,
  keyboardType,
  autoCapitalize,
  autoCorrect,
  multiline = false,
  style,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  keyboardType?: 'decimal-pad' | 'number-pad' | 'phone-pad' | 'email-address';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoCorrect?: boolean;
  multiline?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.field, style]}>
      <AppText variant="section" color={colors.textMuted}>
        {label}
      </AppText>
      <TextInput
        style={[styles.input, multiline && styles.multiline]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textMuted}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={autoCorrect}
        multiline={multiline}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  field: {
    gap: 4,
    marginBottom: spacing.sm,
  },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
  },
  multiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
});
