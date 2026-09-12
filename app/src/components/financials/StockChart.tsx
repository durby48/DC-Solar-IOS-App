import { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type PointerEvent,
} from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { AppText, Card } from '@/components/ui';
import { colors, fonts, hubColors, radii, spacing } from '@/constants/theme';
import { SERIES_START, type SeriesKey, type SeriesPoint, type ValueBreakdown } from '@/lib/valuation';

import { formatRounded, formatSigned } from './format';

/**
 * Robinhood-style stock chart for the top of the Financials screen.
 *
 * One series at a time (Revenue · Profit · Value — the segmented toggle top
 * right), a range (1W · 1M · 3M · All), a ticker headline (latest value and
 * the change since the range start, green up / red down) and SCRUBBING:
 * press or drag anywhere on the plot to snap to the nearest day — a hairline,
 * a dot on the line and a floating date + value. The headline follows the
 * scrub and snaps back to the latest point on release.
 *
 * Input: three equal-length daily series from lib/valuation.ts. The component
 * draws whatever it is given and stores nothing.
 *
 * Gestures. One PanResponder on the plot wrapper claims the touch on start
 * AND on move and refuses termination requests, so the SectionList above it
 * never steals a horizontal scrub on iOS. On web the same responder handles
 * click-and-drag; hovering (no button) is added with pointer events, which
 * react-native-web forwards to the DOM.
 *
 * Drawing. At most ~120 points are drawn — the range is downsampled by
 * day for "All" as the series grows — and the path strings are memoised on
 * (range, width, series), so a scrub only re-renders the hairline and label.
 */

export type ChartRange = '1W' | '1M' | '3M' | 'All';

const RANGES: ChartRange[] = ['1W', '1M', '3M', 'All'];
const RANGE_DAYS: Record<ChartRange, number | null> = { '1W': 7, '1M': 30, '3M': 91, All: null };

const SERIES: { key: SeriesKey; label: string }[] = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'profit', label: 'Profit' },
  { key: 'value', label: 'Value' },
];

const MAX_POINTS = 120;
const PLOT_HEIGHT = 190;
const PAD_X = 6;
const PAD_TOP = 14;
const PAD_BOTTOM = 10;

interface Props {
  series: Record<SeriesKey, SeriesPoint[]>;
  /** Today's composition of the Value line (shown under the chart). */
  breakdown?: ValueBreakdown | null;
}

function fmtDay(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** The visible slice of a series for a range, thinned to MAX_POINTS. */
function visibleSlice(points: SeriesPoint[], range: ChartRange): SeriesPoint[] {
  const days = RANGE_DAYS[range];
  const slice = days == null ? points : points.slice(Math.max(0, points.length - days));
  if (slice.length <= MAX_POINTS) return slice;
  const step = Math.ceil(slice.length / MAX_POINTS);
  const out: SeriesPoint[] = [];
  for (let i = 0; i < slice.length; i += step) out.push(slice[i]);
  if (out[out.length - 1] !== slice[slice.length - 1]) out.push(slice[slice.length - 1]);
  return out;
}

export function StockChart({ series, breakdown }: Props) {
  const [key, setKey] = useState<SeriesKey>('revenue');
  const [range, setRange] = useState<ChartRange>('All');
  const [width, setWidth] = useState(0);
  const [scrub, setScrub] = useState<number | null>(null);

  const points = useMemo(() => visibleSlice(series[key] ?? [], range), [series, key, range]);

  // Geometry: x positions per point, y scale over the visible values.
  const geo = useMemo(() => {
    const n = points.length;
    const innerW = Math.max(0, width - PAD_X * 2);
    const innerH = PLOT_HEIGHT - PAD_TOP - PAD_BOTTOM;
    if (n === 0 || innerW <= 0) {
      return { xs: [] as number[], ys: [] as number[], line: '', area: '', zeroY: null as number | null };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const p of points) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    if (max - min < 1e-9) {
      const pad = Math.max(1, Math.abs(max) * 0.05);
      min -= pad;
      max += pad;
    } else {
      const pad = (max - min) * 0.06;
      min -= pad;
      max += pad;
    }
    const xs: number[] = [];
    const ys: number[] = [];
    const stepX = n > 1 ? innerW / (n - 1) : 0;
    for (let i = 0; i < n; i++) {
      xs.push(PAD_X + (n > 1 ? i * stepX : innerW / 2));
      ys.push(PAD_TOP + innerH - ((points[i].value - min) / (max - min)) * innerH);
    }
    let line = '';
    for (let i = 0; i < n; i++) {
      line += `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)} ${ys[i].toFixed(1)}`;
    }
    const base = PAD_TOP + innerH;
    const area =
      n > 1 ? `${line}L${xs[n - 1].toFixed(1)} ${base}L${xs[0].toFixed(1)} ${base}Z` : '';
    const zeroY = min < 0 && max > 0 ? PAD_TOP + innerH - ((0 - min) / (max - min)) * innerH : null;
    return { xs, ys, line, area, zeroY };
  }, [points, width]);

  // Latest refs for the gesture handlers (created once, below).
  const latest = useRef({ xs: geo.xs, count: points.length });
  useEffect(() => {
    latest.current = { xs: geo.xs, count: points.length };
  }, [geo.xs, points.length]);

  const nearestIndex = (x: number): number | null => {
    const { xs, count } = latest.current;
    if (count === 0) return null;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < xs.length; i++) {
      const d = Math.abs(xs[i] - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onShouldBlockNativeResponder: () => true,
        onPanResponderGrant: (e) => setScrub(nearestIndex(e.nativeEvent.locationX)),
        onPanResponderMove: (e) => setScrub(nearestIndex(e.nativeEvent.locationX)),
        onPanResponderRelease: () => setScrub(null),
        onPanResponderTerminate: () => setScrub(null),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Web hover (no button held) — pointer events reach the DOM node directly.
  const hoverProps =
    Platform.OS === 'web'
      ? {
          onPointerMove: (e: PointerEvent) => {
            const ne = e.nativeEvent as unknown as { offsetX?: number; locationX?: number };
            const x = ne.offsetX ?? ne.locationX;
            if (typeof x === 'number') setScrub(nearestIndex(x));
          },
          onPointerLeave: () => setScrub(null),
        }
      : {};

  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));

  // Headline: the scrubbed point, else the latest.
  const last = points.length > 0 ? points[points.length - 1] : null;
  const first = points.length > 0 ? points[0] : null;
  const active = scrub != null && points[scrub] ? points[scrub] : last;
  const change = active && first ? active.value - first.value : 0;
  const pct = active && first && Math.abs(first.value) > 1e-9 ? (change / Math.abs(first.value)) * 100 : null;
  const up = change >= 0;
  const tone = up ? colors.success : colors.danger;
  const label = SERIES.find((s) => s.key === key)?.label ?? '';

  const rangeCaption =
    range === 'All'
      ? `since ${fmtDay(first?.day ?? SERIES_START)}`
      : range === '1W'
        ? 'past week'
        : range === '1M'
          ? 'past month'
          : 'past 3 months';

  const scrubX = scrub != null ? geo.xs[scrub] : null;
  const scrubY = scrub != null ? geo.ys[scrub] : null;
  // Keep the floating label inside the plot.
  const labelW = 132;
  const labelLeft =
    scrubX == null ? 0 : Math.min(Math.max(scrubX - labelW / 2, 0), Math.max(0, width - labelW));

  return (
    <Card style={styles.card}>
      <View style={styles.topRow}>
        <AppText variant="section" color={colors.textMuted} style={styles.eyebrow}>
          {label}
        </AppText>
        <View style={styles.segmented} accessibilityRole="tablist">
          {SERIES.map((s) => {
            const selected = s.key === key;
            return (
              <Pressable
                key={s.key}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => {
                  setScrub(null);
                  setKey(s.key);
                }}
                style={[styles.segment, selected && styles.segmentOn]}>
                <AppText
                  variant="caption"
                  color={selected ? colors.textOnDark : colors.textSecondary}
                  style={styles.segmentText}>
                  {s.label}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.headline}>
        <AppText variant="display" style={styles.value}>
          {active ? formatSigned(active.value) : '—'}
        </AppText>
        {active && first ? (
          <View style={styles.changeRow}>
            <AppText variant="caption" color={tone} style={styles.change}>
              {up ? '▲' : '▼'} {formatSigned(change)}
              {pct != null ? ` (${up ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)` : ''}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {scrub != null ? fmtDay(active.day) : rangeCaption}
            </AppText>
          </View>
        ) : null}
      </View>

      <View
        style={styles.plot}
        onLayout={onLayout}
        {...responder.panHandlers}
        {...hoverProps}
        accessible
        accessibilityLabel={`${label} chart. Press and drag to read a day's value.`}>
        {points.length < 2 || width === 0 ? (
          <View style={styles.empty}>
            <AppText variant="caption" color={colors.textMuted} align="center">
              {points.length === 0
                ? 'No days on the chart yet.'
                : 'One day so far — the line starts tomorrow.'}
            </AppText>
          </View>
        ) : (
          <Svg width={width} height={PLOT_HEIGHT} pointerEvents="none">
            {geo.zeroY != null ? (
              <Line
                x1={PAD_X}
                x2={width - PAD_X}
                y1={geo.zeroY}
                y2={geo.zeroY}
                stroke={colors.borderStrong}
                strokeWidth={1}
                strokeDasharray="3 4"
              />
            ) : null}
            <Path d={geo.area} fill={tone} fillOpacity={0.1} />
            <Path
              d={geo.line}
              fill="none"
              stroke={tone}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {scrubX != null && scrubY != null ? (
              <>
                <Line
                  x1={scrubX}
                  x2={scrubX}
                  y1={PAD_TOP - 6}
                  y2={PLOT_HEIGHT - PAD_BOTTOM + 4}
                  stroke={colors.textMuted}
                  strokeWidth={1}
                />
                <Circle cx={scrubX} cy={scrubY} r={5} fill={tone} stroke={colors.surface} strokeWidth={2} />
              </>
            ) : (
              last && geo.xs.length > 0 ? (
                <Circle
                  cx={geo.xs[geo.xs.length - 1]}
                  cy={geo.ys[geo.ys.length - 1]}
                  r={4}
                  fill={tone}
                  stroke={colors.surface}
                  strokeWidth={2}
                />
              ) : null
            )}
          </Svg>
        )}
        {scrub != null && active ? (
          <View pointerEvents="none" style={[styles.floating, { left: labelLeft, width: labelW }]}>
            <AppText variant="caption" color={colors.textMuted} align="center">
              {fmtDay(active.day)}
            </AppText>
            <AppText variant="bodyStrong" align="center" style={styles.floatingValue}>
              {formatSigned(active.value)}
            </AppText>
          </View>
        ) : null}
      </View>

      <View style={styles.axisRow}>
        <AppText variant="caption" color={colors.textMuted}>
          {first ? fmtDay(first.day) : ''}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {last ? fmtDay(last.day) : ''}
        </AppText>
      </View>

      <View style={styles.ranges}>
        {RANGES.map((r) => {
          const selected = r === range;
          return (
            <Pressable
              key={r}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              onPress={() => {
                setScrub(null);
                setRange(r);
              }}
              style={[styles.rangeChip, selected && { backgroundColor: hubColors.systems.bg }]}>
              <AppText
                variant="caption"
                color={selected ? hubColors.systems.deep : colors.textMuted}
                style={styles.rangeText}>
                {r}
              </AppText>
            </Pressable>
          );
        })}
      </View>

      {key === 'value' && breakdown ? (
        <View style={styles.breakdown}>
          <BreakdownItem label="Cash" value={breakdown.cash} />
          <BreakdownItem label="Receivables" value={breakdown.receivables} />
          <BreakdownItem label="Backlog" value={breakdown.backlog} />
          <BreakdownItem label="Assets" value={breakdown.assets} />
          <BreakdownItem label="Liabilities" value={-breakdown.liabilities} />
          {!breakdown.cashAnchored ? (
            <AppText variant="caption" color={colors.textMuted} style={styles.note}>
              No bank balance anchored yet — cash is the running net of recorded bank
              flows. Set one in Cash Position below.
            </AppText>
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function BreakdownItem({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.breakdownItem}>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
      <AppText variant="caption" style={styles.breakdownValue}>
        {formatSigned(value)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: hubColors.systems.fg,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  eyebrow: {
    flex: 1,
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.pill,
    padding: 3,
  },
  segment: {
    paddingHorizontal: spacing.md - 2,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  segmentOn: {
    backgroundColor: hubColors.systems.fg,
  },
  segmentText: {
    fontFamily: fonts.bold,
  },
  headline: {
    marginTop: spacing.sm,
    gap: 2,
  },
  value: {
    fontVariant: ['tabular-nums'],
  },
  changeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  change: {
    fontFamily: fonts.bold,
    fontVariant: ['tabular-nums'],
  },
  plot: {
    marginTop: spacing.sm,
    height: PLOT_HEIGHT,
    width: '100%',
    position: 'relative',
    ...(Platform.OS === 'web' ? ({ cursor: 'crosshair' } as object) : null),
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  floating: {
    position: 'absolute',
    top: -8,
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 4,
    paddingHorizontal: spacing.sm,
  },
  floatingValue: {
    fontVariant: ['tabular-nums'],
  },
  axisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: PAD_X,
  },
  ranges: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  rangeChip: {
    paddingHorizontal: spacing.md - 2,
    paddingVertical: 6,
    borderRadius: radii.pill,
  },
  rangeText: {
    fontFamily: fonts.bold,
  },
  breakdown: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  breakdownItem: {
    minWidth: 92,
  },
  breakdownValue: {
    fontFamily: fonts.bold,
    fontVariant: ['tabular-nums'],
  },
  note: {
    width: '100%',
  },
});
