import { Image, type ImageProps } from 'expo-image';
import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { Ticker } from '@/components/Ticker';
import { CountUp } from '@/components/ui';
import { accentCycle, colors, radii, shadows, spacing } from '@/constants/theme';
import { useMotion } from '@/lib/motion';
import { fetchCompanyMetrics, type CompanyMetrics } from '@/lib/metrics';

/**
 * Pipeline header: an animated DC Solar installer fastening a panel, over a
 * scrolling band of company milestone numbers.
 *
 * FOUR crew characters take turns — the one on screen changes every two hours,
 * derived from the clock so everyone in the company sees the same one at the
 * same time rather than a random pick per device.
 *
 * The animation is three illustrated frames per character (generated once,
 * checked by eye, committed as assets) cycled in a small 1→0→2→0 bob — he's screwing the panel
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
 *
 * ── 2026-08-22 rewrite ────────────────────────────────────────────────────
 * This component was the app's biggest performance sink and all three causes
 * are gone:
 *   • the metric numbers counted up by calling `setState` on EVERY animation
 *     frame (four tiles × two ticker copies = eight components re-rendering
 *     at 60fps). They now use `components/ui`'s `CountUp`, which writes the
 *     text from the UI thread natively and quantises to ~40 updates on web.
 *   • the frame flip ran a permanent 170ms `setInterval` that re-rendered the
 *     whole hero. It is now ONE Reanimated shared value the three stacked
 *     images read in their own `useAnimatedStyle` worklets — no React render
 *     per frame at all.
 *   • both of those kept running while the Pipeline tab was off screen. The
 *     flip now pauses when the screen is unfocused.
 * The 60-second character-changeover check stays a `setInterval`: it fires
 * once a minute and its whole job is to change React state.
 */

/**
 * Four crew characters, each drawn as three frames. The whole company sees the
 * SAME character at the same time because the index comes from the clock, not
 * from random — it rotates every two hours.
 */
const CHARACTERS = [
  [
    require('@/assets/images/installer-a-0.jpg'),
    require('@/assets/images/installer-a-1.jpg'),
    require('@/assets/images/installer-a-2.jpg'),
  ],
  [
    require('@/assets/images/installer-b-0.jpg'),
    require('@/assets/images/installer-b-1.jpg'),
    require('@/assets/images/installer-b-2.jpg'),
  ],
  [
    require('@/assets/images/installer-c-0.jpg'),
    require('@/assets/images/installer-c-1.jpg'),
    require('@/assets/images/installer-c-2.jpg'),
  ],
  [
    require('@/assets/images/installer-d-0.jpg'),
    require('@/assets/images/installer-d-1.jpg'),
    require('@/assets/images/installer-d-2.jpg'),
  ],
];

const ROTATE_MS = 2 * 60 * 60 * 1000;

/** Which character is on shift right now. Clock-derived, so it's shared. */
function currentCharacter(now: number): number {
  return Math.floor(now / ROTATE_MS) % CHARACTERS.length;
}
/**
 * Playback order: driver bobs slightly up, mid, seated, mid — a small
 * screwing motion rather than a swinging arm. Frame 1 sits highest, frame 2
 * lowest, frame 0 in between.
 */
const SEQUENCE = [1, 0, 2, 0];
const FRAME_MS = 170;

/**
 * Sentinel for "not playing": the resting pose is frame 0, and a negative
 * progress value is unambiguous where any real step is 0…3.
 */
const PAUSED = -1;

/**
 * One stacked frame. It owns nothing but its own opacity, read from the
 * shared clock in a worklet — so cycling frames never crosses into React.
 */
function Frame({
  source,
  index,
  progress,
}: {
  source: ImageProps['source'];
  index: number;
  progress: SharedValue<number>;
}) {
  const animatedStyle = useAnimatedStyle(() => {
    const step =
      progress.value < 0
        ? 0
        : SEQUENCE[Math.min(Math.floor(progress.value), SEQUENCE.length - 1)];
    return { opacity: step === index ? 1 : 0 };
  });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, animatedStyle]} pointerEvents="none">
      <Image
        source={source}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
        // No transition: these swap every 170ms and a fade would smear.
        transition={0}
      />
    </Animated.View>
  );
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
  const [character, setCharacter] = useState(() => currentCharacter(Date.now()));
  const { enabled } = useMotion();
  const focused = useIsFocused();
  const progress = useSharedValue(PAUSED);

  useEffect(() => {
    let cancelled = false;
    fetchCompanyMetrics().then((result) => {
      if (!cancelled) setMetrics(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The whole frame animation. Off screen or reduced motion, it parks on the
   * resting pose rather than freezing mid-swing — a paused hand halfway to a
   * bracket looks like a rendering bug.
   */
  useEffect(() => {
    if (!enabled || !focused) {
      cancelAnimation(progress);
      progress.value = PAUSED;
      return;
    }
    progress.value = 0;
    progress.value = withRepeat(
      withTiming(SEQUENCE.length, {
        duration: SEQUENCE.length * FRAME_MS,
        easing: Easing.linear,
      }),
      -1,
      false,
    );
    return () => {
      cancelAnimation(progress);
    };
  }, [enabled, focused, progress]);

  // Catch the changeover without needing the app relaunched. Checked once a
  // minute; the value itself only moves every two hours.
  useEffect(() => {
    const timer = setInterval(() => setCharacter(currentCharacter(Date.now())), 60_000);
    return () => clearInterval(timer);
  }, []);

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
        {CHARACTERS[character].map((source, i) => (
          <Frame key={`${character}-${i}`} source={source} index={i} progress={progress} />
        ))}
        <View style={styles.stageFade} />
      </View>

      {tiles.length > 0 ? (
        <Ticker
          style={styles.ticker}
          // Same reason the frame animation parks above: an infinite
          // `withRepeat` keeps running on a tab nobody is looking at.
          paused={!focused}
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
  // No `fontWeight` here: `CountUp` renders with `typography.numeric`, whose
  // Inter_700Bold face already carries the weight. Adding one on top makes
  // iOS synthesise a fake bold over a real one.
  tileValue: {
    color: colors.ink,
    fontSize: 20,
  },
  tileSuffix: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '800',
  },
});
