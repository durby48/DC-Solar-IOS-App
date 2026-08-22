import Ionicons from '@expo/vector-icons/Ionicons';
import {
  ActivityIndicator,
  StyleSheet,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import type { HapticKind } from '@/lib/haptics';
import { AnimatedPressable } from './AnimatedPressable';
import { AppText } from './AppText';

type IconName = keyof typeof Ionicons.glyphMap;

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'onDark';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * The app's button.
 *
 * Variants, and when to use which:
 *   primary   — sun pill with INK text. THE action on a screen; one per view.
 *               The ink text is not a style choice: cream on sun is 1.9:1 and
 *               unreadable outdoors, which is where this app is used.
 *   secondary — white pill, olive outline, olive text. The other thing you
 *               could do here.
 *   ghost     — text only. Cancel, Skip, "not now".
 *   danger    — solid danger. Delete, reject, remove. Never the default focus.
 *   onDark    — cream outline on cream text, for olive/ink surfaces where
 *               every other variant disappears.
 *
 * `loading` swaps the label for a spinner and disables the press, keeping the
 * button's width so the layout doesn't jump mid-save.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  iconRight,
  loading = false,
  disabled = false,
  fullWidth = false,
  haptic = 'tapMedium',
  style,
  textStyle,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  /** Press feedback. Pass `undefined` for a button that shouldn't buzz. */
  haptic?: HapticKind;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}) {
  const tone = VARIANTS[variant];
  const dims = SIZES[size];
  const inert = disabled || loading;

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={inert}
      haptic={inert ? undefined : haptic}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inert, busy: loading }}
      style={[
        styles.base,
        tone.container,
        { paddingVertical: dims.paddingVertical, paddingHorizontal: dims.paddingHorizontal },
        fullWidth && styles.fullWidth,
        disabled && styles.disabled,
        style,
      ]}>
      {loading ? (
        <ActivityIndicator size="small" color={tone.text} />
      ) : (
        <View style={styles.row}>
          {icon ? <Ionicons name={icon} size={dims.icon} color={tone.text} /> : null}
          <AppText variant="button" color={tone.text} style={[{ fontSize: dims.font }, textStyle]}>
            {label}
          </AppText>
          {iconRight ? <Ionicons name={iconRight} size={dims.icon} color={tone.text} /> : null}
        </View>
      )}
    </AnimatedPressable>
  );
}

const VARIANTS: Record<ButtonVariant, { container: ViewStyle; text: string }> = {
  primary: {
    container: { backgroundColor: colors.accentAction },
    text: colors.ink,
  },
  secondary: {
    container: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.borderStrong,
    },
    text: colors.accentPrimary,
  },
  ghost: {
    container: { backgroundColor: 'transparent' },
    text: colors.accentPrimary,
  },
  danger: {
    container: { backgroundColor: colors.danger },
    text: colors.white,
  },
  onDark: {
    container: {
      backgroundColor: 'transparent',
      borderWidth: 1.5,
      borderColor: colors.textOnDark,
    },
    text: colors.textOnDark,
  },
};

const SIZES: Record<ButtonSize, { paddingVertical: number; paddingHorizontal: number; font: number; icon: number }> = {
  sm: { paddingVertical: spacing.xs + 2, paddingHorizontal: spacing.sm + 4, font: 13, icon: 15 },
  md: { paddingVertical: spacing.sm + 2, paddingHorizontal: spacing.md, font: 15, icon: 17 },
  lg: { paddingVertical: spacing.md - 2, paddingHorizontal: spacing.lg, font: 16, icon: 19 },
};

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
    // Comfortably above the 44pt tap target at every size.
    minHeight: 40,
  },
  fullWidth: {
    alignSelf: 'stretch',
    width: '100%',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
  },
  disabled: {
    opacity: 0.45,
  },
});
