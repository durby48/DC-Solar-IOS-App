import { Image, type ImageSource } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { useMemo } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Path, RadialGradient, Rect, Stop } from 'react-native-svg';

import { fonts } from '@/constants/theme';
import {
  cardCorner,
  cardStats,
  cardTypeline,
  type CardRarity,
  type CardRecord,
  type CardVariant,
} from '@/lib/cards';

/**
 * One trading card, drawn to match `print/print_sheets.html` from the
 * dc-solar-tcg repo — the sheet the physical deck was printed from.
 *
 * ────────────────────────────────────────────────────────────────────────
 * EVERY NUMBER IN HERE IS THE PRINT TEMPLATE'S NUMBER
 * ────────────────────────────────────────────────────────────────────────
 * The card is poker-size: 2.5in × 3.5in, 0.09in of white bleed, a 3px frame
 * with a 10px radius, and a 1.42in art window. The CSS expresses that in
 * inches and CSS pixels; this component takes a `width` in device pixels and
 * derives everything from it, so a 150px thumbnail in the grid and a 340px
 * hero on the detail screen are the same card at two scales rather than two
 * hand-tuned layouts.
 *
 *   s      pixels per CSS inch at this width
 *   inch() CSS inches → device px
 *   px()   CSS pixels → device px  (96 CSS px = 1 CSS inch)
 *
 * Do not replace a derived value with a constant. A "16" that should be
 * `px(12)` looks right at one width and wrong at every other.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IS EXACT AND WHAT IS APPROXIMATED
 * ────────────────────────────────────────────────────────────────────────
 * EXACT: the geometry, the five rarity palettes (hexes copied from the CSS),
 * the head band, the frame wash (both radial gradients and the conic ray fan
 * are re-derived in SVG user space from the same percentages and stops), the
 * burst badge, the stat-pill rules including their quirks, and the full-art
 * scrim.
 *
 * APPROXIMATED, because React Native has no `mix-blend-mode`: the foil sweep
 * (CSS `screen`) and the holo rainbow (CSS `overlay`) are composited normally
 * with their opacities pulled down until they read the same. A `screen`
 * highlight over dark art brightens without hazing; plain alpha at the CSS
 * opacity would fog the whole picture, so the alphas here are lower than the
 * stylesheet's on purpose. If a blend-mode prop ever lands in RN, restore the
 * CSS numbers and delete the fudge.
 */

// ---------------------------------------------------------------------------
// Rarity palettes — hexes copied verbatim from print_sheets.html
// ---------------------------------------------------------------------------

interface RarityPalette {
  /** `--frame`: the 3px border, the typeline text, the stat-pill outline. */
  frame: string;
  /** `--band`: the 135° head-band gradient. */
  band: readonly [string, string];
  /** `--rrgb`: the wash / stat-pill tint, as an "r,g,b" triple. */
  rgb: string;
  /** The burst badge's core and ray colours (`--rc1` / `--rc2`). */
  burst: readonly [string, string];
}

const RARITY: Record<CardRarity, RarityPalette> = {
  common: {
    frame: '#5d6b79',
    band: ['#b6c2ce', '#75828f'],
    rgb: '110,125,140',
    burst: ['#dfe7ee', '#647383'],
  },
  uncommon: {
    frame: '#157a39',
    band: ['#57df84', '#1d9e4b'],
    rgb: '34,174,90',
    burst: ['#7dffa8', '#16813c'],
  },
  rare: {
    frame: '#1257b5',
    band: ['#57aaff', '#1663c7'],
    rgb: '47,127,212',
    burst: ['#7cc4ff', '#1257b5'],
  },
  legendary: {
    frame: '#c96e00',
    band: ['#ffd84d', '#ff8a00'],
    rgb: '250,140,10',
    burst: ['#ffd84d', '#ff7a00'],
  },
  secret: {
    frame: '#6b1fe0',
    band: ['#b06ef7', '#7b2ff7'],
    rgb: '138,60,235',
    burst: ['#dd9bff', '#6b1fe0'],
  },
};

/** Full-art cards write on the scrim, not on the wash. */
const GOLD = '#ffd84d';
const FULLART_TEXT = '#fff2d8';
const FULLART_FLAVOR = '#e8c98f';

/** 2.5in × 3.5in. Exported so a grid can size its columns from one number. */
export const CARD_ASPECT = 3.5 / 2.5;

/** The frame's inner box in CSS px — the SVG wash's user space. */
const WASH_W = 232;
const WASH_H = 332;

export interface TradingCardProps {
  card: CardRecord;
  /** Signed URL from `fetchCardArtUrls`, or a `require()`d local asset. */
  artUrl?: string | number | ImageSource | null;
  variant?: CardVariant;
  /** Device pixels. Height follows at 2.5:3.5. */
  width: number;
  /** Show the printed back instead of the face. */
  showBack?: boolean;
  style?: StyleProp<ViewStyle>;
}

export function TradingCard({
  card,
  artUrl,
  variant = 'base',
  width,
  showBack = false,
  style,
}: TradingCardProps) {
  const s = width / 2.5;
  const inch = (value: number) => value * s;
  const px = (value: number) => (value / 96) * s;

  const height = inch(3.5);
  const bleed = inch(0.09);

  if (showBack) {
    return (
      <View style={[{ width, height, padding: bleed }, style]}>
        <CardBack width={width - bleed * 2} height={height - bleed * 2} px={px} inch={inch} />
      </View>
    );
  }

  const palette = RARITY[card.rarity] ?? RARITY.common;
  const fullArt = card.full_art;
  // Sold a Damn Cow is holographic full-art ONLY: the sheet forces the holo
  // overlay on every full-art card regardless of which finish is selected.
  const holo = variant === 'holo' || fullArt;
  const foil = variant === 'foil' && !fullArt;

  const stats = cardStats(card);
  const typeline = cardTypeline(card);
  const corner = cardCorner(card);

  // A `require()`d asset is a NUMBER on native and an OBJECT on web, so only a
  // plain string gets wrapped. Wrapping the others produced `{uri: {...}}`,
  // which expo-image reports as "s?.uri?.startsWith is not a function".
  const source: ImageSource | number | null =
    typeof artUrl === 'string' ? { uri: artUrl } : (artUrl ?? null);

  const headColors = foil ? FOIL_BAND : fullArt ? FULLART_HEAD : palette.band;
  const titleColor = foil ? '#1c2733' : '#fff';

  const lower = (
    <>
      {/* typeline */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: px(8),
          paddingTop: px(3),
        }}>
        <Text
          numberOfLines={1}
          style={{
            flexShrink: 1,
            fontFamily: fonts.bold,
            fontSize: px(8),
            letterSpacing: px(8) * 0.08,
            textTransform: 'uppercase',
            color: fullArt ? GOLD : palette.frame,
          }}>
          {typeline}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: px(2) }}>
          <Burst rarity={card.rarity} size={px(26)} />
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: px(8),
              letterSpacing: px(8) * 0.08,
              textTransform: 'uppercase',
              color: fullArt ? GOLD : palette.frame,
            }}>
            {card.rarity}
          </Text>
        </View>
      </View>

      {/* body */}
      <View style={{ paddingHorizontal: px(8), paddingVertical: px(3) }}>
        {card.ability ? (
          <Text
            style={{
              fontFamily: fonts.bold,
              fontSize: px(8.6),
              lineHeight: px(8.6) * 1.25,
              marginBottom: px(3),
              color: fullArt ? FULLART_TEXT : '#000',
            }}>
            {card.ability}
          </Text>
        ) : null}
        {card.flavor ? (
          <Text
            style={{
              fontFamily: fonts.body,
              fontStyle: 'italic',
              fontSize: px(8),
              lineHeight: px(8) * 1.25,
              color: fullArt ? FULLART_FLAVOR : '#555',
            }}>
            {/* The curly quotes are added in render, exactly as the sheet does. */}
            {`“${card.flavor}”`}
          </Text>
        ) : null}
      </View>

      {/* stats */}
      {stats.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: px(4),
            paddingHorizontal: px(8),
            paddingBottom: px(6),
          }}>
          {stats.map((stat) => (
            <View
              key={stat}
              style={{
                borderRadius: px(4),
                borderWidth: Math.max(StyleSheet.hairlineWidth, px(1)),
                borderColor: fullArt ? GOLD : palette.frame,
                backgroundColor: fullArt
                  ? 'rgba(255,216,77,0.15)'
                  : `rgba(${palette.rgb},0.12)`,
                paddingHorizontal: px(5),
                paddingVertical: px(2),
              }}>
              <Text
                style={{
                  fontFamily: fonts.bold,
                  fontSize: px(8),
                  color: fullArt ? GOLD : '#000',
                }}>
                {stat}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </>
  );

  return (
    <View style={[{ width, height, padding: bleed }, style]}>
      <View
        style={{
          flex: 1,
          borderRadius: px(10),
          borderWidth: px(3),
          borderColor: palette.frame,
          overflow: 'hidden',
          backgroundColor: fullArt ? '#000' : '#fff',
        }}>
        {/* Rarity wash — the flood that makes a legendary read as gold from
            across the room. Full-art cards are black behind the picture. */}
        {fullArt ? null : <FrameWash rgb={palette.rgb} />}

        {/* Full-art: the picture IS the card. */}
        {fullArt ? (
          <View style={StyleSheet.absoluteFill}>
            {source ? (
              <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" />
            ) : (
              <ArtPlaceholder px={px} />
            )}
          </View>
        ) : null}

        {/* head */}
        <LinearGradient
          colors={headColors}
          locations={foil ? FOIL_BAND_STOPS : undefined}
          start={foil ? { x: 0, y: 0.42 } : fullArt ? { x: 0.5, y: 0 } : { x: 0, y: 0 }}
          end={foil ? { x: 1, y: 0.58 } : fullArt ? { x: 0.5, y: 1 } : { x: 1, y: 1 }}
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            paddingHorizontal: px(8),
            paddingVertical: px(4),
          }}>
          <Text
            numberOfLines={2}
            style={{
              flexShrink: 1,
              fontFamily: fonts.bold,
              fontSize: px(11.5),
              lineHeight: px(11.5) * 1.1,
              color: titleColor,
              textShadowColor: foil ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.35)',
              textShadowOffset: { width: 0, height: px(1) },
              textShadowRadius: px(2),
            }}>
            {card.title}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              marginLeft: px(4),
              fontFamily: fonts.bold,
              fontSize: px(10),
              color: titleColor,
            }}>
            {corner}
          </Text>
        </LinearGradient>

        {/* art window (base layout only — full-art already filled the frame) */}
        {fullArt ? (
          <View style={{ flex: 1 }} />
        ) : (
          <View
            style={{
              height: inch(1.42),
              borderBottomWidth: px(2),
              borderBottomColor: palette.frame,
              overflow: 'hidden',
            }}>
            {source ? (
              <Image source={source} style={StyleSheet.absoluteFill} contentFit="cover" />
            ) : (
              <ArtPlaceholder px={px} />
            )}
            {foil ? <FoilSweep /> : null}
          </View>
        )}

        {/* lower block */}
        {fullArt ? (
          <LinearGradient
            colors={FULLART_LOWER}
            locations={FULLART_LOWER_STOPS}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={{ paddingTop: px(8) }}>
            {lower}
          </LinearGradient>
        ) : (
          <View>{lower}</View>
        )}

        {holo ? <HoloOverlay px={px} /> : null}
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Art placeholder
// ---------------------------------------------------------------------------

/** The sheet's `linear-gradient(160deg,…)` plus its ☀️, for art-less cards. */
function ArtPlaceholder({ px }: { px: (value: number) => number }) {
  return (
    <LinearGradient
      colors={['#ffe9c2', '#ffc45e', '#ff9d2e']}
      locations={[0, 0.6, 1]}
      start={{ x: 0.2, y: 0 }}
      end={{ x: 0.8, y: 1 }}
      style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
      <Text style={{ fontSize: px(30), opacity: 0.55 }}>☀️</Text>
    </LinearGradient>
  );
}

// ---------------------------------------------------------------------------
// Frame wash
// ---------------------------------------------------------------------------

/**
 * The four-layer CSS background on `.frame`, rebuilt in SVG.
 *
 *   linear-gradient(165deg, #fff, rgba(rrgb,.20))          the base tint
 *   radial-gradient(circle at 6% 52%,  rgba(rrgb,.14) …)   the left glow
 *   radial-gradient(circle at 88% 96%, rgba(rrgb,.34) …)   the corner flood
 *   repeating-conic-gradient(from -8deg at 88% 96%, …)     the ray fan
 *
 * SVG rather than stacked `LinearGradient`s because two of the four are
 * genuinely radial and one is conic; faking a radial with a linear ramp is
 * what makes ported card art look flat.
 *
 * CSS sizes a `circle` radial by its distance to the FARTHEST CORNER, so each
 * radius below is that distance and each colour stop is the CSS percentage of
 * it. The conic fan is fifteen 6°-wide wedges on a 24° period starting at
 * -8°, drawn as paths from the same corner point.
 */
function FrameWash({ rgb }: { rgb: string }) {
  const wedges = useMemo(() => conicWedges(204.16, 318.72, 500, -8, 24, 6), []);
  // SVG ids are DOCUMENT-scoped on web: every card on the page shares one
  // namespace, so a fixed "wash" would paint all sixty-one cards in whichever
  // rarity happened to mount first. Keying the id by the colour makes the
  // collision harmless — same id, identical definition.
  const key = rgb.replace(/,/g, '-');

  return (
    <Svg
      style={styles.fillNoTouch}
      width="100%"
      height="100%"
      viewBox={`0 0 ${WASH_W} ${WASH_H}`}
      preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient
          id={`wash-${key}`}
          x1="66.7"
          y1="-17.8"
          x2="165.3"
          y2="349.8"
          gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#ffffff" stopOpacity="1" />
          <Stop offset="1" stopColor={`rgb(${rgb})`} stopOpacity="0.2" />
        </SvgLinearGradient>
        {/* circle at 6% 52%, transparent by 42% of the farthest-corner radius */}
        <RadialGradient
          id={`glowLeft-${key}`}
          cx="13.92"
          cy="172.64"
          r="278.1"
          gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={`rgb(${rgb})`} stopOpacity="0.14" />
          <Stop offset="0.42" stopColor={`rgb(${rgb})`} stopOpacity="0" />
        </RadialGradient>
        {/* circle at 88% 96%, transparent by 62% */}
        <RadialGradient
          id={`glowCorner-${key}`}
          cx="204.16"
          cy="318.72"
          r="378.5"
          gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={`rgb(${rgb})`} stopOpacity="0.34" />
          <Stop offset="0.62" stopColor={`rgb(${rgb})`} stopOpacity="0" />
        </RadialGradient>
      </Defs>

      <Rect x="0" y="0" width={WASH_W} height={WASH_H} fill={`url(#wash-${key})`} />
      <Rect x="0" y="0" width={WASH_W} height={WASH_H} fill={`url(#glowLeft-${key})`} />
      <Rect x="0" y="0" width={WASH_W} height={WASH_H} fill={`url(#glowCorner-${key})`} />
      {wedges.map((d, i) => (
        <Path key={i} d={d} fill={`rgb(${rgb})`} fillOpacity={0.1} />
      ))}
    </Svg>
  );
}

/**
 * Wedge paths for a `repeating-conic-gradient`.
 *
 * CSS conic angles start at 12 o'clock and run clockwise; SVG angles start at
 * 3 o'clock and also run clockwise (because y points down), so the conversion
 * is a flat −90°. Each wedge is a triangle-with-an-arc from the centre out to
 * `radius`, which is deliberately larger than the card so the fan is clipped
 * by the SVG viewport rather than ending in mid-air.
 */
function conicWedges(
  cx: number,
  cy: number,
  radius: number,
  from: number,
  period: number,
  sweep: number,
): string[] {
  const paths: string[] = [];
  const point = (deg: number) => {
    const rad = ((deg - 90) * Math.PI) / 180;
    return `${(cx + radius * Math.cos(rad)).toFixed(2)} ${(cy + radius * Math.sin(rad)).toFixed(2)}`;
  };
  for (let start = from; start < from + 360; start += period) {
    paths.push(`M ${cx} ${cy} L ${point(start)} A ${radius} ${radius} 0 0 1 ${point(start + sweep)} Z`);
  }
  return paths;
}

// ---------------------------------------------------------------------------
// Rarity burst badge
// ---------------------------------------------------------------------------

/**
 * The little exploding gem beside the rarity word.
 *
 * CSS builds it from two pseudo-elements: a conic ray fan masked by a radial
 * alpha ramp, and a radial-gradient core with a drop shadow. There is no mask
 * here — the ray fill IS a radial gradient of the ray colour whose alpha runs
 * 1 → 0.75 → 0 at 12 % / 42 % / 72 %, which is arithmetically the same thing
 * and one paint instead of two.
 *
 * `size` is the CSS 26px footprint; the rays overhang it by 4px on every side
 * (CSS `inset: -4px`), so the SVG is 34 units square and negative margins pull
 * the layout box back to `size`.
 */
function Burst({ rarity, size }: { rarity: CardRarity; size: number }) {
  const [core, ray] = (RARITY[rarity] ?? RARITY.common).burst;
  const id = `burst-${rarity}`;
  const box = (size * 34) / 26;
  const overhang = (box - size) / 2;
  const rays = useMemo(() => conicWedges(17, 17, 17, -4, 30, 7), []);

  return (
    <Svg
      width={box}
      height={box}
      viewBox="0 0 34 34"
      style={{ margin: -overhang, pointerEvents: 'none' }}>
      <Defs>
        {/* r = distance to the farthest corner of the 34×34 box */}
        <RadialGradient id={`${id}-rays`} cx="17" cy="17" r="24.04" gradientUnits="userSpaceOnUse">
          <Stop offset="0.12" stopColor={ray} stopOpacity="1" />
          <Stop offset="0.42" stopColor={ray} stopOpacity="0.75" />
          <Stop offset="0.72" stopColor={ray} stopOpacity="0" />
        </RadialGradient>
        {/* r = farthest corner of the inset 18×18 box */}
        <RadialGradient id={`${id}-core`} cx="17" cy="17" r="12.73" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#ffffff" stopOpacity="1" />
          <Stop offset="0.16" stopColor="#ffffff" stopOpacity="1" />
          <Stop offset="0.34" stopColor={core} stopOpacity="1" />
          <Stop offset="0.58" stopColor={ray} stopOpacity="1" />
          <Stop offset="0.74" stopColor={ray} stopOpacity="0" />
        </RadialGradient>
      </Defs>
      {rays.map((d, i) => (
        <Path key={i} d={d} fill={`url(#${id}-rays)`} />
      ))}
      <Circle cx="17" cy="17" r="12.73" fill={`url(#${id}-core)`} />
    </Svg>
  );
}

// ---------------------------------------------------------------------------
// Finishes
// ---------------------------------------------------------------------------

/** `body[data-variant="foil"] .head` — the brushed-metal title band. */
const FOIL_BAND = [
  '#b8c6d4',
  '#f4f9ff',
  '#93a7b8',
  '#e8f1f8',
  '#a9bccb',
  '#d7e4ee',
] as const;
const FOIL_BAND_STOPS = [0, 0.22, 0.45, 0.62, 0.85, 1] as const;

/** `.card.fullart .head` — a dark scrim so the title survives any picture. */
const FULLART_HEAD = ['rgba(20,10,0,0.72)', 'rgba(20,10,0,0)'] as const;
const FULLART_LOWER = ['rgba(20,10,0,0)', 'rgba(20,10,0,0.78)', 'rgba(20,10,0,0.9)'] as const;
const FULLART_LOWER_STOPS = [0, 0.28, 1] as const;

/**
 * The foil sweep across the artwork.
 *
 * CSS blends this with `screen`, which only ever brightens. Plain alpha at the
 * same opacities greys the picture, so the stops here are the stylesheet's
 * colours at roughly two-thirds strength — bright enough to read as metal,
 * weak enough that the art still shows through.
 *
 * The 115° angle is converted to unit-square start/end points for the art
 * window's own 1.63:1 proportion; a naive {0,0}→{1,1} diagonal would run at
 * about 58° on that box and the sweep would look like a corner shadow.
 */
function FoilSweep() {
  return (
    <LinearGradient
      colors={[
        'rgba(255,255,255,0)',
        'rgba(255,255,255,0)',
        'rgba(255,255,255,0.30)',
        'rgba(140,210,255,0.20)',
        'rgba(255,255,255,0)',
        'rgba(255,196,94,0.24)',
        'rgba(255,255,255,0.18)',
        'rgba(255,255,255,0)',
        'rgba(255,255,255,0)',
      ]}
      locations={[0, 0.18, 0.28, 0.38, 0.52, 0.66, 0.74, 0.86, 1]}
      start={{ x: -0.03, y: 0.09 }}
      end={{ x: 1.03, y: 0.91 }}
      style={styles.fillNoTouch}
    />
  );
}

/** The rainbow band, one 98px CSS period repeated across the card. */
const HOLO_BAND = [
  'rgba(255,70,70,0.55)',
  'rgba(255,185,45,0.55)',
  'rgba(255,240,95,0.55)',
  'rgba(80,225,130,0.55)',
  'rgba(70,185,255,0.55)',
  'rgba(160,100,255,0.55)',
  'rgba(255,70,210,0.55)',
] as const;
const HOLO_REPEATS = 4;

/** Four fixed sparkles, at the CSS percentages. */
const SPARKLES = [
  { left: '22%', top: '18%', scale: 1.5, opacity: 0.9 },
  { left: '71%', top: '39%', scale: 1.2, opacity: 0.8 },
  { left: '43%', top: '76%', scale: 1.4, opacity: 0.8 },
  { left: '87%', top: '88%', scale: 1.2, opacity: 0.75 },
] as const;

/**
 * The holographic finish: a diffraction rainbow, a white sweep on top of it,
 * and four specular sparkles.
 *
 * CSS blends the rainbow with `overlay`, which darkens the dark half of the
 * card and brightens the light half — the reason a real holo looks like it is
 * *inside* the card rather than laid over it. RN can only composite normally,
 * so the whole stack sits at ~0.3 opacity with per-stop alphas around 0.55,
 * landing near the same visual weight without turning the artwork into a
 * tie-dye T-shirt.
 *
 * The 125° angle and the repeat count are derived from the card's real
 * diagonal so the band spacing matches the print: a 98px CSS period fits
 * about 3.8 times across a poker card, hence four.
 */
function HoloOverlay({ px }: { px: (value: number) => number }) {
  const { colors, locations } = useMemo(() => {
    const out: string[] = [];
    const stops: number[] = [];
    const total = HOLO_REPEATS * HOLO_BAND.length;
    for (let i = 0; i <= total; i++) {
      out.push(HOLO_BAND[i % HOLO_BAND.length]);
      stops.push(i / total);
    }
    return {
      colors: out as unknown as readonly [string, string, ...string[]],
      locations: stops as unknown as readonly [number, number, ...number[]],
    };
  }, []);

  const dot = px(3);

  return (
    <View style={[styles.fillNoTouch, { opacity: 0.3 }]}>
      <LinearGradient
        colors={colors}
        locations={locations}
        start={{ x: -0.17, y: 0.17 }}
        end={{ x: 1.17, y: 0.83 }}
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        colors={[
          'rgba(255,255,255,0)',
          'rgba(255,255,255,0)',
          'rgba(255,255,255,0.55)',
          'rgba(255,255,255,0)',
          'rgba(255,255,255,0.42)',
          'rgba(255,255,255,0)',
          'rgba(255,255,255,0)',
        ]}
        locations={[0, 0.12, 0.26, 0.4, 0.68, 0.82, 1]}
        start={{ x: -0.17, y: 0.17 }}
        end={{ x: 1.17, y: 0.83 }}
        style={StyleSheet.absoluteFill}
      />
      {SPARKLES.map((sparkle, i) => (
        <View
          key={i}
          style={{
            position: 'absolute',
            left: sparkle.left,
            top: sparkle.top,
            width: dot * sparkle.scale,
            height: dot * sparkle.scale,
            borderRadius: (dot * sparkle.scale) / 2,
            backgroundColor: '#fff',
            opacity: sparkle.opacity,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  /** Overlay that must never eat a tap. `pointerEvents` lives in the style
      rather than the prop — the prop is deprecated in RN 0.86. */
  fillNoTouch: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    pointerEvents: 'none',
  },
});

// ---------------------------------------------------------------------------
// Card back
// ---------------------------------------------------------------------------

const CARDBACK = require('@/assets/images/tcg-cardback.webp');
const LOGO = require('@/assets/images/logo.png');

/**
 * The printed back: the bundled cardback art with the DC Solar logo in a gold
 * medallion. CSS makes the medallion a 1.72in × 1.06in ellipse with a gold
 * ring outside a dark-gold border; RN has no elliptical radius, so it is drawn
 * as a stadium (radius = half the height), which at this size is
 * indistinguishable and holds the logo the same way.
 */
function CardBack({
  width,
  height,
  px,
  inch,
}: {
  width: number;
  height: number;
  px: (value: number) => number;
  inch: (value: number) => number;
}) {
  const medallionW = inch(1.72);
  const medallionH = inch(1.06);

  return (
    <View
      style={{
        width,
        height,
        borderRadius: px(10),
        overflow: 'hidden',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#1b1408',
      }}>
      <Image source={CARDBACK} style={StyleSheet.absoluteFill} contentFit="cover" />
      <View
        style={{
          padding: px(3),
          backgroundColor: GOLD,
          borderRadius: medallionH / 2 + px(3),
        }}>
        <LinearGradient
          colors={['#fffdf4', '#f3e6c3']}
          start={{ x: 0.5, y: 0.15 }}
          end={{ x: 0.5, y: 1 }}
          style={{
            width: medallionW,
            height: medallionH,
            borderRadius: medallionH / 2,
            borderWidth: px(3),
            borderColor: '#8a6d00',
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}>
          <Image
            source={LOGO}
            style={{ width: medallionW * 0.82, height: medallionH * 0.72 }}
            contentFit="contain"
          />
        </LinearGradient>
      </View>
    </View>
  );
}
