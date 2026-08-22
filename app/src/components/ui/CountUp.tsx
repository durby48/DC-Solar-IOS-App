import { useEffect, useState } from 'react';
import {
  Platform,
  StyleSheet,
  TextInput,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
} from 'react-native';
import Animated, {
  runOnJS,
  useAnimatedProps,
  useAnimatedReaction,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { colors, typography } from '@/constants/theme';
import { DURATION, EASE, useMotion } from '@/lib/motion';
import { AppText } from './AppText';

const AnimatedTextInput = Animated.createAnimatedComponent(TextInput);
const IS_WEB = Platform.OS === 'web';

export interface CountUpProps {
  /** The number to land on. Changing it counts from wherever it is now. */
  value: number;
  duration?: number;
  /** Decimal places. 2 for money, 0 for counts. */
  decimals?: number;
  /** Thousands separators. */
  separator?: boolean;
  /** Glued to the front, inside the animation — e.g. '$'. */
  prefix?: string;
  /** Glued to the end — e.g. 'h', '%'. */
  suffix?: string;
  style?: StyleProp<TextStyle>;
  /** Screen-reader label; defaults to the final formatted value. */
  accessibilityLabel?: string;
}

/**
 * Worklet-safe number formatting.
 *
 * This has to be a `'worklet'` at module scope, because the native path
 * formats on the UI thread sixty times a second inside `useAnimatedProps`.
 * Calling `Intl`, `toLocaleString`, or a `format` callback passed in as a
 * prop from there would either break the worklet runtime or bounce every
 * frame back to JS — which is exactly the per-frame `setState` this component
 * was written to replace. That is why the API is
 * `prefix`/`suffix`/`decimals`/`separator` and not a formatter function: the
 * shape is limited on purpose.
 */
function formatValue(
  value: number,
  decimals: number,
  separator: boolean,
  prefix: string,
  suffix: string,
): string {
  'worklet';
  const safe = Number.isFinite(value) ? value : 0;
  const negative = safe < 0;
  const fixed = Math.abs(safe).toFixed(decimals);
  const dot = fixed.indexOf('.');
  let whole = dot === -1 ? fixed : fixed.slice(0, dot);
  const fraction = dot === -1 ? '' : fixed.slice(dot);

  if (separator && whole.length > 3) {
    let grouped = '';
    let count = 0;
    for (let i = whole.length - 1; i >= 0; i -= 1) {
      grouped = whole.charAt(i) + grouped;
      count += 1;
      if (count % 3 === 0 && i > 0) grouped = `,${grouped}`;
    }
    whole = grouped;
  }

  return `${negative ? '-' : ''}${prefix}${whole}${fraction}${suffix}`;
}

/** `text` is a real TextInput prop natively but isn't in the RN types. */
type AnimatableTextProps = TextInputProps & { text: string; defaultValue: string };

/**
 * Native: the number is written straight onto a `TextInput`'s `text` prop
 * from the UI thread. This is the standard Reanimated trick for animating
 * text — `Text` has no animatable text prop, `TextInput` does — so the count
 * never touches React state or the JS thread.
 *
 * The input is `editable={false}` and non-interactive, so it behaves as a
 * label. The accessible value is set once, from the FINAL number: a screen
 * reader announcing every intermediate value would be unusable.
 */
function CountUpNative({
  value,
  duration = DURATION.lazy,
  decimals = 0,
  separator = true,
  prefix = '',
  suffix = '',
  style,
  accessibilityLabel,
}: CountUpProps) {
  const { enabled } = useMotion();
  const shown = useSharedValue(enabled ? 0 : value);
  const final = formatValue(value, decimals, separator, prefix, suffix);

  useEffect(() => {
    shown.value = withTiming(value, { duration: enabled ? duration : 0, easing: EASE.out });
  }, [value, duration, enabled, shown]);

  const animatedProps = useAnimatedProps<AnimatableTextProps>(() => {
    const text = formatValue(shown.value, decimals, separator, prefix, suffix);
    // `defaultValue` alongside `text` is what makes the very first paint show
    // a number rather than an empty box on iOS.
    return { text, defaultValue: text };
  });

  return (
    <AnimatedTextInput
      animatedProps={animatedProps}
      editable={false}
      pointerEvents="none"
      underlineColorAndroid="transparent"
      accessible
      accessibilityLabel={accessibilityLabel ?? final}
      style={[typography.numeric, styles.input, style]}
    />
  );
}

/**
 * Web: react-native-web has no native text prop to drive, so the count has to
 * come back to React. It does so QUANTISED — the value is bucketed into ~40
 * steps and only a bucket CHANGE crosses `runOnJS`. That's ~40 renders for a
 * whole count instead of the ~54 a 900ms 60fps per-frame listener would cost,
 * and it is the difference between this being cheap and it being the
 * per-frame `setState` that used to live in `PipelineHero`.
 */
function CountUpWeb({
  value,
  duration = DURATION.lazy,
  decimals = 0,
  separator = true,
  prefix = '',
  suffix = '',
  style,
  accessibilityLabel,
}: CountUpProps) {
  const { enabled } = useMotion();
  const progress = useSharedValue(enabled ? 0 : value);
  const [shown, setShown] = useState(enabled ? 0 : value);
  const final = formatValue(value, decimals, separator, prefix, suffix);

  // One bucket, never finer than the smallest visible digit change.
  const step = Math.max(Math.abs(value) / 40, 10 ** -decimals);

  useEffect(() => {
    if (!enabled) {
      progress.value = value;
      setShown(value);
      return;
    }
    progress.value = withTiming(value, { duration, easing: EASE.out }, (finished) => {
      // Land on the exact number — the last bucket is an approximation.
      if (finished) runOnJS(setShown)(value);
    });
  }, [value, duration, enabled, progress]);

  useAnimatedReaction(
    () => Math.round(progress.value / step),
    (bucket, previous) => {
      if (previous !== null && bucket !== previous) runOnJS(setShown)(bucket * step);
    },
    [step],
  );

  return (
    <AppText variant="numeric" accessibilityLabel={accessibilityLabel ?? final} style={style}>
      {formatValue(shown, decimals, separator, prefix, suffix)}
    </AppText>
  );
}

/**
 * A number that counts up on mount, and animates to any later value.
 * Reduced motion: it is simply the number, immediately.
 */
export function CountUp(props: CountUpProps) {
  return IS_WEB ? <CountUpWeb {...props} /> : <CountUpNative {...props} />;
}

const styles = StyleSheet.create({
  input: {
    // Strip every affordance that says "you can type here".
    padding: 0,
    margin: 0,
    borderWidth: 0,
    color: colors.textPrimary,
    ...Platform.select({ web: { outlineStyle: 'none' as never }, default: {} }),
  },
});
