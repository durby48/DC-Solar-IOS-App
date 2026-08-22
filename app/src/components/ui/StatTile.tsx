import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { accentCycle, colors, radii, spacing } from '@/constants/theme';
import { AppText } from './AppText';
import { CountUp } from './CountUp';

/** Index into `accentCycle`, or the brand olive. */
export type StatTone = number | 'olive';

/**
 * One number with a label — the shape used by the financials tiles, the job
 * finance ticker and the pipeline hero band.
 *
 * `countUp` is on by default: a number that arrives by counting tells you it
 * just loaded, which is the honest signal for a screen whose data refetches
 * on focus. Turn it off for a value that changes often (a live timer), where
 * counting to it every tick would be noise.
 *
 * `decimals`/`prefix`/`separator` are passed through to `CountUp` rather than
 * a formatter callback — see the note there about worklets.
 */
export function StatTile({
  label,
  value,
  suffix,
  prefix,
  decimals = 0,
  tone = 0,
  countUp = true,
  compact = false,
  style,
}: {
  label: string;
  value: number;
  /** Unit glued after the number: 'h', '%', ' kW'. */
  suffix?: string;
  /** Unit glued before it: '$'. */
  prefix?: string;
  decimals?: number;
  tone?: StatTone;
  countUp?: boolean;
  /** Tighter padding for a dense row of tiles. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const palette = paletteFor(tone);

  return (
    <View
      style={[
        styles.tile,
        compact ? styles.compact : null,
        { backgroundColor: palette.bg },
        style,
      ]}>
      <AppText variant="section" color={palette.fg} numberOfLines={2}>
        {label}
      </AppText>
      <CountUp
        value={value}
        prefix={prefix}
        suffix={suffix}
        decimals={decimals}
        duration={countUp ? undefined : 0}
        style={[styles.value, compact ? styles.valueCompact : null]}
      />
    </View>
  );
}

function paletteFor(tone: StatTone): { bg: string; fg: string } {
  if (tone === 'olive') return { bg: colors.oliveSoft, fg: colors.oliveDeep };
  const entry = accentCycle[Math.abs(Math.floor(tone)) % accentCycle.length];
  return { bg: entry.bg, fg: entry.fg };
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minWidth: 120,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  compact: {
    padding: spacing.sm + 2,
    gap: 2,
  },
  value: {
    color: colors.textPrimary,
  },
  valueCompact: {
    fontSize: 18,
    lineHeight: 23,
  },
});
