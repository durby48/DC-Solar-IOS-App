/**
 * DC Solar KC brand theme — soft, sunny, rounded.
 * All colors/spacing/radii live here; screens should not hardcode hex values.
 *
 * 2026-08-04 palette overhaul: the original four hues (cream / sun / ocean /
 * ink) made every card read the same, so stages and stat tiles were hard to
 * tell apart at a glance. The brand core is unchanged — everything below it is
 * an ADDITION. Never delete a key here; screens across the app reference them.
 *
 * Naming convention for the accent ramp:
 *   <name>      — the saturated hue, safe for text on a soft/white background
 *   <name>Soft  — the tinted background chip color for that hue
 *   <name>Deep  — the darkened hue, safe for white text on top
 *
 * 2026-08-22 foundation pass (Workstream B). Everything added below is an
 * ADDITION on top of the two sets above; nothing was renamed or removed.
 *
 *   Semantic aliases  — `surface`, `textPrimary`, `accentAction`… Reach for
 *     these in NEW code. They say what a color is FOR, so a future palette
 *     move is one edit here instead of 1,500 across the screens. The literal
 *     names (`cream`, `ocean`, …) stay valid forever for the existing code.
 *   `gradients`       — ready-made stop lists for expo-linear-gradient.
 *   `shadows.subtle` / `shadows.hero` — the two ends the card/raised pair was
 *     missing: a hairline lift, and a floating headline surface.
 *   `fonts` / `typography` — Sora for headings, Inter for everything else.
 *
 * OLIVE CONTRAST RULES (measured against the surface underneath):
 *   • cream or white text ON olive / oliveDeep / gradients.olive — always fine
 *     (6.21:1 and 9.26:1). This is the ONLY way to use olive as a background.
 *   • olive or oliveDeep text ON cream / white / oliveSoft / oliveTint — fine.
 *   • oliveMid is 4.45:1 on cream: icons, and large text only (18pt+, or 14pt
 *     bold). Never body copy, never a caption.
 *   • NEVER white or cream on sun (#FFB066 — 1.9:1). The sun pill takes INK
 *     text; `Button` variant "primary" already does this for you.
 *   • Hairlines on top of olive use `oliveLine`, not `line`/`tan` — those
 *     disappear against it.
 * Type never carries `fontFamily` AND `fontWeight` in the same style object:
 * a weight on a named face makes iOS synthesise a fake bold and Android fall
 * back to the system font. Pick the face that already has the weight.
 */

import type { TextStyle } from 'react-native';

export const colors = {
  // ---- brand core (unchanged) ----
  cream: '#FFF3E6',
  sun: '#FFB066',
  sunLight: '#FFD3A6',
  ocean: '#5AA8CF',
  sky: '#9FD6F2',
  skySoft: '#DCEFFB',
  tan: '#ECD9BE',
  ink: '#3D352E',
  inkSoft: '#6B5D4F',
  white: '#FFFFFF',
  card: '#FFFFFF',
  danger: '#C0564A',
  success: '#3E8E5E',

  // ---- olive core (2026-08 brand evolution) ----
  // Dark olive green joins cream / sun / ocean / ink as a core brand color.
  // Contrast figures are measured against `cream` (#FFF3E6):
  //   olive     #4D5C2B — 6.21:1, AA for body text and icons on cream
  //   oliveMid  #66783A — 4.45:1, icons and large (18pt+/14pt bold) text only
  //   oliveDeep #3A461F — 9.26:1, AAA; also the safe ground for cream/white text
  //   oliveSoft #E7EDD8 — tinted chip/background fill
  //   oliveTint #F2F5E9 — faintest wash, for full-bleed sections
  //   oliveLine rgba(255,243,230,0.18) — hairline/divider *on top of* olive
  // Header rule: cream/white on olive; olive/oliveDeep on cream; never white on sun.
  // olive / oliveDeep / oliveSoft are mirrored in targets/widget/index.swift
  // (Theme enum) and targets/widget/expo-target.config.js — the widget is Swift
  // and cannot import this file, so change those three in all three places.
  olive: '#4D5C2B',
  oliveMid: '#66783A',
  oliveDeep: '#3A461F',
  oliveSoft: '#E7EDD8',
  oliveTint: '#F2F5E9',
  oliveLine: 'rgba(255,243,230,0.18)',

  // ---- accent ramp (new) ----
  teal: '#2F9C95',
  tealSoft: '#D6F0EE',
  tealDeep: '#1F6F6A',

  indigo: '#5C6BC0',
  indigoSoft: '#E1E4F7',
  indigoDeep: '#3F4A94',

  violet: '#8A63C7',
  violetSoft: '#EDE3F8',
  violetDeep: '#634391',

  coral: '#E4744F',
  coralSoft: '#FBE0D6',
  coralDeep: '#B4522F',

  rose: '#D45D7E',
  roseSoft: '#FADDE5',
  roseDeep: '#A03D5B',

  amber: '#D99512',
  amberSoft: '#FBEBC8',
  amberDeep: '#A46E06',

  lime: '#6BA33F',
  limeSoft: '#E4F2D6',
  limeDeep: '#4B7A28',

  mint: '#49B37B',
  mintSoft: '#DAF3E5',
  mintDeep: '#2F7C53',

  slate: '#6E7C8C',
  slateSoft: '#E4E9EE',
  slateDeep: '#4A5765',

  // ---- surfaces (new) ----
  /** Page background alternative with a cooler cast. */
  canvas: '#FBF6EF',
  /** Hairline / divider that reads softer than tan on white. */
  line: '#EFE3D2',

  // ---- semantic aliases (2026-08-22) ----
  // Same values as the literals above, named for the JOB rather than the hue.
  // New code should use these; old code keeps working untouched.
  /** A raised thing sitting on the page: cards, rows, sheets. */
  surface: '#FFFFFF',
  /** The page itself. */
  surfaceAlt: '#FFF3E6',
  /** Inset/recessed panel — a well punched INTO a cream page. */
  surfaceSunk: '#F5EDE2',
  /** Dark ground for cream text: headers, the clock card when on-clock. */
  surfaceInverse: '#3A461F',
  /** Body and heading copy on a light surface. */
  textPrimary: '#3D352E',
  /** Supporting copy: subtitles, row seconds lines. */
  textSecondary: '#6B5D4F',
  /** The quietest legible text — timestamps, footnotes, disabled labels. */
  textMuted: '#7A6C5C',
  /** Anything written on olive / oliveDeep / ink. */
  textOnDark: '#FFF3E6',
  /** Default hairline between rows. */
  border: '#EFE3D2',
  /** Visible outline: input rings, secondary buttons, card edges. */
  borderStrong: '#E0CDB2',
  /** The brand's lead color — olive. Headers, primary icons, Complete. */
  accentPrimary: '#4D5C2B',
  /** The thing you tap. Sun, and it always carries INK text. */
  accentAction: '#FFB066',
  /** Links and back arrows stay ocean, the way the app already reads. */
  accentLink: '#5AA8CF',
  /** Tinted ground for a destructive card or an error row. */
  dangerSoft: '#F4DDD9',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 10,
  md: 16,
  lg: 24,
  pill: 999,
} as const;

export const shadows = {
  /**
   * Barely there — a hairline lift for a row, chip or inset panel that needs
   * to separate from the page without reading as a card.
   */
  subtle: {
    shadowColor: colors.ink,
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  card: {
    shadowColor: colors.ink,
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  /** Lifted surface for headline cards (totals, clock). */
  raised: {
    shadowColor: colors.ink,
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  /**
   * The one surface allowed to float: the Home clock card overlapping the
   * header. Deliberately heavier than `raised` — use it once per screen.
   */
  hero: {
    shadowColor: colors.ink,
    shadowOpacity: 0.2,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
} as const;

/**
 * Ordered accent set for anything that needs "the next distinct color" —
 * stat tiles, ticker items, chart-ish rows. Cycle with index % length.
 */
export const accentCycle = [
  { fg: colors.ocean, bg: colors.skySoft },
  { fg: colors.teal, bg: colors.tealSoft },
  { fg: colors.indigo, bg: colors.indigoSoft },
  { fg: colors.violet, bg: colors.violetSoft },
  { fg: colors.coral, bg: colors.coralSoft },
  { fg: colors.amber, bg: colors.amberSoft },
  { fg: colors.lime, bg: colors.limeSoft },
  { fg: colors.rose, bg: colors.roseSoft },
] as const;

/**
 * Cartoon-property art palettes (consumed by components/PropertyArt.tsx).
 * Each entry is one coherent "house look"; the component picks one
 * deterministically from the job id so a property always draws the same.
 */
export const artPalettes = [
  { sky: '#CDE8F7', siding: '#DCE3EA', trim: '#FFFFFF', roof: '#8C99A6', brick: '#C08A72' },
  { sky: '#D8ECFA', siding: '#E7DCCB', trim: '#FFFFFF', roof: '#7E7367', brick: '#B87F63' },
  { sky: '#C8E6F3', siding: '#CFE0D6', trim: '#FDFDFB', roof: '#6F7F76', brick: '#AD7B66' },
  { sky: '#DCEAF8', siding: '#EBD9D2', trim: '#FFFFFF', roof: '#96786C', brick: '#A9705B' },
  { sky: '#CFE9F5', siding: '#D4D9E6', trim: '#FFFFFF', roof: '#77809B', brick: '#B58472' },
  { sky: '#E0EEF9', siding: '#F0E4D4', trim: '#FFFFFF', roof: '#A08A72', brick: '#BE8A6E' },
] as const;

/** Greens used for lawn/foliage in the property art, light → deep. */
export const artGreens = ['#CFE9B4', '#BEE0A0', '#A9D389', '#8FC46E', '#6FA855'] as const;

export type JobStatus = 'active' | 'completed' | 'on_hold';

export const statusColors: Record<JobStatus, { bg: string; text: string; label: string }> = {
  active: { bg: colors.skySoft, text: colors.ocean, label: 'Active' },
  completed: { bg: colors.tan, text: colors.inkSoft, label: 'Completed' },
  on_hold: { bg: colors.sunLight, text: colors.ink, label: 'On hold' },
};

/**
 * Gradient stop lists for `expo-linear-gradient` (and `components/ui`'s
 * `GradientSurface`, which is the nicer way to reach them).
 *
 * Each is a readonly tuple so it drops straight into LinearGradient's
 * `colors` prop, which wants at least two stops. Direction is the caller's
 * business — every one of these is authored to read top-to-bottom or
 * left-to-right without changing meaning.
 *
 * Contrast, so nobody has to guess:
 *   olive / oliveSky / ink  → cream or white text ONLY.
 *   sunrise / cream         → ink text ONLY (never white — see the header).
 *   ocean                   → white text at the deep end, ink at the light
 *                             end; prefer white and keep copy short.
 *   shimmer / scrimDown     → overlays, not text grounds.
 */
export const gradients = {
  /** The brand header. Olive rising to its deepest value. */
  olive: ['#66783A', '#4D5C2B', '#3A461F'],
  /** Olive ground lifting into brand ocean — the Home hero surface. */
  oliveSky: ['#3A461F', '#4D5C2B', '#5AA8CF'],
  /** Warm call-to-action fill: the off-clock clock card, primary hero pills. */
  sunrise: ['#FFD3A6', '#FFB066'],
  /** Sky into ocean. Water-cool counterweight to the sun ramp. */
  ocean: ['#9FD6F2', '#5AA8CF'],
  /** Almost-flat page wash, cream into canvas. Use to fake depth cheaply. */
  cream: ['#FFF3E6', '#FBF6EF'],
  /** Neutral dark surface when olive would be too loud. */
  ink: ['#6B5D4F', '#3D352E'],
  /** Skeleton sweep: transparent → highlight → transparent. */
  shimmer: ['rgba(255,243,230,0)', 'rgba(255,255,255,0.72)', 'rgba(255,243,230,0)'],
  /** Bottom-of-photo scrim so caption text stays readable over any image. */
  scrimDown: ['rgba(61,53,46,0)', 'rgba(61,53,46,0.62)'],
} as const satisfies Record<string, readonly [string, string, ...string[]]>;

export type GradientKey = keyof typeof gradients;

/**
 * The six loaded faces. Sora (the dcsolarkc.com headline face) carries
 * headings; Inter carries everything a person actually reads.
 *
 * These strings are the keys the root `_layout.tsx` registers with
 * `useFonts` — change one here and you must change it there.
 *
 * NEVER pair one of these with `fontWeight`. The weight is baked into the
 * face; adding `fontWeight: '700'` on top makes iOS synthesise a smeared
 * fake-bold and Android drop back to the system font. That is also why there
 * is no `fontWeight` anywhere in `typography` below.
 */
export const fonts = {
  /** Sora 700 — section and card headings. */
  heading: 'Sora_700Bold',
  /** Sora 800 — page titles and the big numbers people look for. */
  display: 'Sora_800ExtraBold',
  /** Inter 400 — body copy. */
  body: 'Inter_400Regular',
  /** Inter 500 — captions, metadata. */
  medium: 'Inter_500Medium',
  /** Inter 600 — emphasised body, row titles. */
  semibold: 'Inter_600SemiBold',
  /** Inter 700 — buttons, eyebrow labels, numerics. */
  bold: 'Inter_700Bold',
} as const;

export type TypographyVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'section'
  | 'body'
  | 'bodyStrong'
  | 'caption'
  | 'numeric'
  | 'button';

/**
 * The whole type scale. Screens never reach for a font size directly — they
 * use `<AppText variant="…">` from `components/ui`, which looks the variant
 * up here. That is the only reason the app can change its type in one edit.
 *
 * There is deliberately NO global default font: RN has no cascade, so a
 * "default" would silently miss every `<Text>` that isn't an `AppText` and
 * we'd end up with two typefaces on the same screen and no way to see which.
 */
export const typography: Record<TypographyVariant, TextStyle> = {
  /** Page title on Home and any hero surface. One per screen. */
  display: { fontFamily: fonts.display, fontSize: 30, lineHeight: 36, letterSpacing: -0.4 },
  /** Screen title where a display would shout. */
  title: { fontFamily: fonts.display, fontSize: 24, lineHeight: 30, letterSpacing: -0.3 },
  /** Card and group heading. */
  heading: { fontFamily: fonts.heading, fontSize: 17, lineHeight: 23, letterSpacing: -0.1 },
  /** The small uppercase eyebrow above a group of rows. */
  section: {
    fontFamily: fonts.bold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  /** Default. Everything a person reads a sentence of. */
  body: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  /** Body weight-up: row titles, an answer to a label. */
  bodyStrong: { fontFamily: fonts.semibold, fontSize: 15, lineHeight: 21 },
  /** Metadata, timestamps, helper text. */
  caption: { fontFamily: fonts.medium, fontSize: 12, lineHeight: 16 },
  /**
   * Money, hours, counts. `tabular-nums` is the point: without it a counting
   * number visibly jitters as digit widths change mid-animation.
   */
  numeric: {
    fontFamily: fonts.bold,
    fontSize: 22,
    lineHeight: 27,
    fontVariant: ['tabular-nums'],
    letterSpacing: -0.2,
  },
  /** Button labels. */
  button: { fontFamily: fonts.bold, fontSize: 15, lineHeight: 20, letterSpacing: 0.2 },
};
