import { Image } from 'expo-image';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';

import { Ticker } from '@/components/Ticker';
import { accentCycle, colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchCompanyMetrics, type CompanyMetrics } from '@/lib/metrics';

/**
 * Pipeline header: an animated DC Solar installer fastening a panel, over a
 * scrolling band of company milestone numbers.
 *
 * The animation is three illustrated frames (generated once, checked by eye,
 * committed as assets) cycled in a small 1→0→2→0 bob — he's screwing the panel
 * down to the rail, not swinging his arm. All three are rendered stacked and
 * cross-faded by opacity rather than swapping one `source`, which avoids a
 * decode flicker on the first cycle.
 *
 * Art notes, learned by regenerating: the frames must show BOTH boots flat on
 * the shingles clear of the panel (the first attempt clipped a foot through
 * it) and the driver angled DOWN at the bracket throughout. They're also
 * pre-cropped to ~2.3 aspect so `contentFit="cover"` doesn't shave the hard
 * hat off at phone width.
 *
 * No video library: playing real video would need a native dependency and
 * therefore a full App Store build. This ships over the air.
 */

const FRAMES = [
  require('@/assets/images/installer-0.jpg'),
  require('@/assets/images/installer-1.jpg'),
  require('@/assets/images/installer-2.jpg'),
];
/**
 * Playback order: driver bobs slightly up, mid, seated, mid — a small
 * screwing motion rather than a swinging arm. Frame 1 sits highest, frame 2
 * lowest, frame 0 in between.
 */
const SEQUENCE = [1, 0, 2, 0];
const FRAME_MS = 170;

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

/** Counts a number up once on mount so the band feels alive on arrival. */
function CountUp({ value, style }: { value: number; style: object }) {
  const [shown, setShown] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    anim.setValue(0);
    const listener = anim.addListener(({ value: v }) => setShown(v * value));
    Animated.timing(anim, {
      toValue: 1,
      duration: 900,
      easing: Easing.out(Easing.cubic),
      // Driving a JS listener means this can't run on the native thread.
      useNativeDriver: false,
    }).start();
    return () => anim.removeListener(listener);
  }, [value, anim]);

  return <Text style={style}>{formatNumber(shown)}</Text>;
}

function MetricTile({
  label,
  value,
  suffix,
  index,
}: {
  label: string;
  value: number;
  suffix?: string;
  index: number;
}) {
  const accent = accentCycle[index % accentCycle.length];
  return (
    <View style={styles.tile}>
      <View style={[styles.tileDot, { backgroundColor: accent.fg }]} />
      <View style={styles.tileText}>
        <Text style={[styles.tileLabel, { color: accent.fg }]}>{label}</Text>
        <View style={styles.tileValueRow}>
          <CountUp value={value} style={styles.tileValue} />
          {suffix ? <Text style={styles.tileSuffix}>{suffix}</Text> : null}
        </View>
      </View>
    </View>
  );
}

export function PipelineHero() {
  const [metrics, setMetrics] = useState<CompanyMetrics | null>(null);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchCompanyMetrics().then((result) => {
      if (!cancelled) setMetrics(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const timer = setInterval(
      () => setFrame((n) => (n + 1) % SEQUENCE.length),
      FRAME_MS,
    );
    return () => clearInterval(timer);
  }, []);

  const activeFrame = SEQUENCE[frame];

  const tiles = metrics
    ? [
        { label: 'Panels R&R’d to date', value: metrics.panelsReinstalled },
        { label: 'Projects completed', value: metrics.projectsCompleted },
        { label: 'Total company hours', value: metrics.totalHours, suffix: 'h' },
        { label: 'Critter guard panels', value: metrics.critterGuardPanels },
      ]
    : [];

  return (
    <View style={styles.card}>
      <View style={styles.stage}>
        {FRAMES.map((source, i) => (
          <Image
            key={i}
            source={source}
            style={[StyleSheet.absoluteFill, { opacity: i === activeFrame ? 1 : 0 }]}
            contentFit="cover"
            cachePolicy="memory-disk"
            // No transition: these swap every 170ms and a fade would smear.
            transition={0}
          />
        ))}
        <View style={styles.stageFade} />
      </View>

      {tiles.length > 0 ? (
        <Ticker
          style={styles.ticker}
          items={tiles.map((tile, i) => (
            <MetricTile
              label={tile.label}
              value={tile.value}
              suffix={tile.suffix}
              index={i}
            />
          ))}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderRadius: radii.md,
    overflow: 'hidden',
    marginBottom: spacing.md,
    ...shadows.card,
  },
  stage: {
    height: 150,
    backgroundColor: colors.skySoft,
  },
  // Softens the bottom edge of the artwork into the metric band.
  stageFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 18,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  ticker: {
    paddingVertical: spacing.sm,
    ...Platform.select({ web: { cursor: 'default' as never }, default: {} }),
  },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    // Trailing margin (not `gap`) keeps both ticker copies the same width.
    marginRight: spacing.sm,
  },
  tileDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  tileText: {
    gap: 2,
  },
  tileLabel: {
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  tileValueRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 3,
  },
  tileValue: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
  },
  tileSuffix: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
  },
});
