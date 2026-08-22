import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { AnimatedPressable } from './AnimatedPressable';
import { AppText } from './AppText';

type IconName = keyof typeof Ionicons.glyphMap;

export type ChipTone = 'neutral' | 'olive' | 'sun' | 'ocean' | 'danger' | 'success';

/**
 * A tappable selection chip: filter rows, segmented choices, the job picker
 * on the clock card.
 *
 * Selected state is a FILL change, not just a border change — on a phone in
 * sunlight a 1px outline is not a state anyone can see. Unselected chips are
 * the soft tint of their tone; selected chips are the saturated hue with
 * contrasting text.
 *
 * Without `onPress` it renders as a static tag (and stays non-interactive to
 * screen readers).
 */
export function Chip({
  label,
  tone = 'neutral',
  selected = false,
  onPress,
  icon,
  disabled = false,
  style,
}: {
  label: string;
  tone?: ChipTone;
  selected?: boolean;
  onPress?: () => void;
  icon?: IconName;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = TONES[tone];
  const bg = selected ? palette.onBg : palette.offBg;
  const fg = selected ? palette.onFg : palette.offFg;

  const body = (
    <>
      {icon ? <Ionicons name={icon} size={14} color={fg} /> : null}
      <AppText variant="caption" color={fg} numberOfLines={1}>
        {label}
      </AppText>
    </>
  );

  const shape: StyleProp<ViewStyle> = [
    styles.chip,
    { backgroundColor: bg, borderColor: selected ? palette.onBg : palette.offBorder },
    disabled && styles.disabled,
    style,
  ];

  if (!onPress) {
    return <View style={shape}>{body}</View>;
  }

  return (
    <AnimatedPressable
      onPress={onPress}
      disabled={disabled}
      haptic="tapLight"
      // A chip is small; a 4% squash reads as a wobble, so press it less far.
      scaleTo={0.94}
      accessibilityRole="button"
      accessibilityState={{ selected, disabled }}
      accessibilityLabel={label}
      style={shape}>
      {body}
    </AnimatedPressable>
  );
}

const TONES: Record<
  ChipTone,
  { offBg: string; offFg: string; offBorder: string; onBg: string; onFg: string }
> = {
  neutral: {
    offBg: colors.surface,
    offFg: colors.textSecondary,
    offBorder: colors.borderStrong,
    onBg: colors.ink,
    onFg: colors.cream,
  },
  olive: {
    offBg: colors.oliveSoft,
    offFg: colors.oliveDeep,
    offBorder: colors.oliveSoft,
    onBg: colors.olive,
    onFg: colors.cream,
  },
  sun: {
    offBg: colors.sunLight,
    offFg: colors.ink,
    offBorder: colors.sunLight,
    // Sun keeps INK text in both states — cream on sun is unreadable.
    onBg: colors.sun,
    onFg: colors.ink,
  },
  ocean: {
    offBg: colors.skySoft,
    offFg: colors.ocean,
    offBorder: colors.skySoft,
    onBg: colors.ocean,
    onFg: colors.white,
  },
  danger: {
    offBg: colors.dangerSoft,
    offFg: colors.danger,
    offBorder: colors.dangerSoft,
    onBg: colors.danger,
    onFg: colors.white,
  },
  success: {
    offBg: colors.mintSoft,
    offFg: colors.mintDeep,
    offBorder: colors.mintSoft,
    onBg: colors.success,
    onFg: colors.white,
  },
};

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs + 2,
    borderRadius: radii.pill,
    borderWidth: 1,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.xs + 2,
    alignSelf: 'flex-start',
  },
  disabled: {
    opacity: 0.45,
  },
});
