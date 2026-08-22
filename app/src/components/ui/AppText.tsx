import { Text, type StyleProp, type TextProps, type TextStyle } from 'react-native';

import { colors, typography, type TypographyVariant } from '@/constants/theme';

/**
 * Every piece of text in a restyled screen goes through here.
 *
 * React Native has no CSS cascade, so there is no way to set "the app's font"
 * once — a global default would silently miss every plain `<Text>` and we'd
 * ship two typefaces on the same screen without noticing. Routing type
 * through one component is the substitute for a cascade: the scale lives in
 * `typography`, and a variant name is the only thing a screen has to know.
 *
 * `style` is spread LAST, so a one-off tweak at a call site always wins.
 */
export function AppText({
  variant = 'body',
  color = colors.textPrimary,
  align,
  style,
  children,
  ...rest
}: TextProps & {
  /** Which step of the type scale. See `typography` in constants/theme. */
  variant?: TypographyVariant;
  /** Defaults to `textPrimary`; pass `textOnDark` on olive/ink surfaces. */
  color?: string;
  align?: TextStyle['textAlign'];
  style?: StyleProp<TextStyle>;
}) {
  return (
    <Text
      {...rest}
      style={[typography[variant], { color }, align ? { textAlign: align } : null, style]}>
      {children}
    </Text>
  );
}
