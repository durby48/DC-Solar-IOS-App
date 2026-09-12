/**
 * DC Solar KC brand theme — "Sonoran dusk" (2026-09-12 dark overhaul).
 *
 * The app is DARK: a warm brown-charcoal page, a slightly lifted charcoal
 * card, and desert pastels for everything that carries meaning — desert tan
 * for the thing you tap, soft terracotta for danger, cactus sage for the brand
 * lead, and dusty rose / sky / ochre / sage / eucalyptus for the five hubs.
 * Nothing neon: every accent is a mid-lightness pastel that reads on charcoal
 * without glare, which is the point of a dark palette on a phone used outdoors.
 *
 * HOW THE NAMES SURVIVED THE FLIP. Screens reference the literal names
 * (`cream`, `ink`, `white`, `olive`…) about 1,500 times, so the NAMES stayed
 * and the VALUES moved to the dark-mode role each name was already playing:
 *
 *   cream / canvas / surfaceAlt   the page
 *   card / surface                a raised card
 *   surfaceSunk                   a well or input INSIDE a card (lighter, the
 *                                 way iOS dark mode lifts a field)
 *   ink / inkSoft / textMuted     light body / supporting / quiet text
 *   white / textOnDark            still #FFFFFF — text on the few solid dark
 *                                 grounds and on danger badges
 *   <hue>Soft / <hue>Tint         a dark tinted chip fill
 *   <hue>                         the pastel: icons, edges, text on charcoal
 *   <hue>Deep                     a LIGHTER pastel — the high-contrast text on
 *                                 <hue>Soft. It is not a ground any more.
 *
 * Three things could not survive by renaming alone and got NEW tokens:
 *   textInverse    dark text for anything sitting ON a pastel fill — a
 *                  selected chip, an ocean pill, a hub-tinted FAB.
 *   textOnAction   dark text on the tan action pill (`sun` / `accentAction`).
 *   oliveGround and hub*Ground — the solid dark grounds that `oliveDeep` and
 *                  `hub*Deep` used to be, for the surfaces that carry white
 *                  text: the on-clock card, the plaque, `Card tone="olive"`.
 *
 * Never delete a key here; screens across the app reference them.
 *
 * CONTRAST RULES (measured; page #1E1C1A, card #2A2623):
 *   • ink / textPrimary on the card — 13.6:1. inkSoft 6.4:1. textMuted 4.5:1.
 *   • Every pastel (`ocean`, `olive`, the hub `fg`s, the accent ramp) is
 *     4.9:1 or better on the card, so it is safe as text and as icons.
 *   • textOnAction on sun — 8.4:1. NEVER ink on sun: ink is LIGHT now.
 *   • textInverse on any pastel fill — 5:1 or better. NEVER white on a pastel.
 *   • white / textOnDark on oliveGround, surfaceInverse, hub*Ground — 8:1+.
 *   • danger carries WHITE only on icon badges (3.2:1, the number is
 *     redundant with the dot); danger BUTTONS and chips take textInverse.
 *   • Hairlines on top of oliveGround use `oliveLine`, not `line` / `tan`.
 *
 * Type never carries `fontFamily` AND `fontWeight` in the same style object:
 * a weight on a named face makes iOS synthesise a fake bold and Android fall
 * back to the system font. Pick the face that already has the weight.
 *
 * The widget is Swift and cannot import this file: `cream` (its background),
 * `sun`, `ocean`, `ink`, `inkSoft`, `olive`, `oliveDeep` and `oliveSoft` are
 * mirrored in targets/widget/index.swift (Theme enum) and
 * targets/widget/expo-target.config.js — change those in all three places.
 */

import type { TextStyle } from 'react-native';

export const colors = {
  // ---- brand core (names kept; values are the dark roles) ----
  /** The page. Warm brown-charcoal. */
  cream: '#1E1C1A',
  /** Desert tan — the thing you tap. Carries `textOnAction`, never ink. */
  sun: '#D8B98A',
  /** Dark tan tint: a chip or banner fill under ink text. */
  sunLight: '#3F3628',
  /** Pastel sky blue: links, back arrows, Pending Install. */
  ocean: '#8DA9BD',
  sky: '#A9C0D0',
  skySoft: '#2C3238',
  /** Hairline. */
  tan: '#3D3833',
  /** Body text. */
  ink: '#EFE7DC',
  inkSoft: '#B8AD9F',
  /** Pure white: text on danger badges and on the solid dark grounds. */
  white: '#FFFFFF',
  card: '#2A2623',
  /** Soft terracotta. Text on the card (4.4:1) and the fill for badges. */
  danger: '#D4776A',
  /** Muted cactus green. 4.8:1 as text on the card. */
  success: '#67A47C',

  // ---- olive (cactus) core ----
  // Contrast figures are measured against the card (#2A2623):
  //   olive       #A9B894 — 7.9:1, the sage that leads the brand
  //   oliveMid    #8FA37C — 5.2:1, icons and secondary sage
  //   oliveDeep   #C4D0B3 — 10.2:1, text on oliveSoft; NOT a ground now
  //   oliveSoft   #2E3A2B — tinted chip fill
  //   oliveTint   #262D24 — faintest wash
  //   oliveGround #34402F — the solid cactus ground under white / ink text
  //   oliveLine   rgba(239,231,220,0.14) — hairline ON TOP of oliveGround
  olive: '#A9B894',
  oliveMid: '#8FA37C',
  oliveDeep: '#C4D0B3',
  oliveSoft: '#2E3A2B',
  oliveTint: '#262D24',
  oliveLine: 'rgba(239,231,220,0.14)',
  /** The one solid cactus ground: the Home band, the plaque, the call screen. */
  oliveGround: '#34402F',

  // ---- accent ramp ----
  // <name>      the pastel — text, icons, edges on charcoal
  // <name>Soft  the dark tinted fill behind it
  // <name>Deep  a lighter pastel: the text that sits ON <name>Soft
  teal: '#79A8A0',
  tealSoft: '#263230',
  tealDeep: '#A6C8C1',

  indigo: '#8E9BC9',
  indigoSoft: '#2B2E3B',
  indigoDeep: '#B3BCDC',

  violet: '#A99BC7',
  violetSoft: '#312D3A',
  violetDeep: '#C6BCDB',

  coral: '#D39A80',
  coralSoft: '#3B2E27',
  coralDeep: '#E4B8A4',

  rose: '#C98DA1',
  roseSoft: '#3A2B32',
  roseDeep: '#DCAFBE',

  amber: '#D4B07E',
  amberSoft: '#3B3427',
  amberDeep: '#E5C99F',

  lime: '#A3B87E',
  limeSoft: '#30352A',
  limeDeep: '#C0D09F',

  mint: '#8FBFA3',
  mintSoft: '#293630',
  mintDeep: '#B0D5BF',

  slate: '#9AA5AB',
  slateSoft: '#2F3235',
  slateDeep: '#B9C2C7',

  // ---- surfaces ----
  /** Page background alias. */
  canvas: '#1E1C1A',
  /** Hairline / divider that reads softer than tan on the card. */
  line: '#3A3531',

  // ---- semantic aliases ----
  // Same values as the literals above, named for the JOB rather than the hue.
  // New code should use these; old code keeps working untouched.
  /** A raised thing sitting on the page: cards, rows, sheets. */
  surface: '#2A2623',
  /** The page itself. */
  surfaceAlt: '#1E1C1A',
  /** A well or input inside a card — LIFTED, the way iOS dark mode does it. */
  surfaceSunk: '#332E2A',
  /** Solid cactus ground for white text: the call screen, Card "olive". */
  surfaceInverse: '#34402F',
  /** Body and heading copy. */
  textPrimary: '#EFE7DC',
  /** Supporting copy: subtitles, row second lines. */
  textSecondary: '#B8AD9F',
  /** The quietest legible text — timestamps, footnotes, disabled labels. */
  textMuted: '#9A9083',
  /** Anything written on oliveGround / surfaceInverse / a hub ground. */
  textOnDark: '#FFFFFF',
  /** Dark text for anything that sits ON a pastel fill. */
  textInverse: '#1E1C1A',
  /** Muted dark text on a LIGHT panel (the sign-in inputs over the art). */
  textInverseMuted: '#6B5D4F',
  /** Dark text on the tan action pill. Never use ink there. */
  textOnAction: '#2A2218',
  /** Default hairline between rows. */
  border: '#3A3531',
  /** Visible outline: input rings, secondary buttons, card edges. */
  borderStrong: '#4B4540',
  /** The brand's lead color — sage. Icons, eyebrows, Complete. */
  accentPrimary: '#A9B894',
  /** The thing you tap. Tan, and it always carries `textOnAction`. */
  accentAction: '#D8B98A',
  /** Links and back arrows stay ocean, the way the app already reads. */
  accentLink: '#8DA9BD',
  /** Tinted ground for a destructive card or an error row. */
  dangerSoft: '#3B2724',

  // ---- hub colours ----
  // One pastel per Home hub, on the hub tile, its icon, the colour edge around
  // the tile and the section eyebrow. `Soft` is the tinted icon square,
  // `Deep` the text on that square, `Ground` the solid fill under white text.
  /** CRM — customers, leads, email, phone, sales. Dusty rose. */
  hubCrm: '#B98A9E',
  hubCrmSoft: '#3A2F33',
  hubCrmDeep: '#D0A9BA',
  hubCrmGround: '#5A424E',
  /** Pipeline — the job board. Sky. */
  hubPipeline: '#8DA9BD',
  hubPipelineSoft: '#2E3338',
  hubPipelineDeep: '#ACC1D1',
  hubPipelineGround: '#3B4F5E',
  /** Operations — calendar and schedule. Ochre. */
  hubOperations: '#CFA46F',
  hubOperationsSoft: '#3B3427',
  hubOperationsDeep: '#E0C08F',
  hubOperationsGround: '#66502F',
  /** Human Resources — hours, paystubs, time off, cards, employees. Sage. */
  hubHr: '#8FA37C',
  hubHrSoft: '#31352C',
  hubHrDeep: '#B0C29E',
  hubHrGround: '#3C4A34',
  /** Systems Management — financials, security, monitoring, receipts. Eucalyptus. */
  hubSystems: '#7FA89B',
  hubSystemsSoft: '#2C3531',
  hubSystemsDeep: '#A3C4B9',
  hubSystemsGround: '#2F4A43',
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

/**
 * Shadows are BLACK, not ink — ink is light now and a light shadow reads as a
 * glow. The opacities are higher than the light palette's because a shadow
 * has to work harder to separate charcoal from charcoal.
 */
export const shadows = {
  /**
   * Barely there — a hairline lift for a row, chip or inset panel that needs
   * to separate from the page without reading as a card.
   */
  subtle: {
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  /** Lifted surface for headline cards (totals, clock). */
  raised: {
    shadowColor: '#000000',
    shadowOpacity: 0.42,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  /**
   * The one surface allowed to float: the Home clock card overlapping the
   * header. Deliberately heavier than `raised` — use it once per screen.
   */
  hero: {
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
} as const;

/** The five Home hubs, in Home order. */
export type HubKey = 'crm' | 'pipeline' | 'operations' | 'hr' | 'systems';

/**
 * fg = icon / edge / eyebrow (the pastel), bg = the tinted icon square,
 * deep = text on that square, ground = the solid fill under WHITE text.
 * Put `textInverse` on `fg`, never white.
 */
export const hubColors: Record<HubKey, { fg: string; bg: string; deep: string; ground: string }> = {
  crm: { fg: colors.hubCrm, bg: colors.hubCrmSoft, deep: colors.hubCrmDeep, ground: colors.hubCrmGround },
  pipeline: {
    fg: colors.hubPipeline,
    bg: colors.hubPipelineSoft,
    deep: colors.hubPipelineDeep,
    ground: colors.hubPipelineGround,
  },
  operations: {
    fg: colors.hubOperations,
    bg: colors.hubOperationsSoft,
    deep: colors.hubOperationsDeep,
    ground: colors.hubOperationsGround,
  },
  hr: { fg: colors.hubHr, bg: colors.hubHrSoft, deep: colors.hubHrDeep, ground: colors.hubHrGround },
  systems: {
    fg: colors.hubSystems,
    bg: colors.hubSystemsSoft,
    deep: colors.hubSystemsDeep,
    ground: colors.hubSystemsGround,
  },
};

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
 * The art stays daylight — it sits under a dark readability scrim now.
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
 *   olive / oliveSky / ink / cream → ink or white text.
 *   sunrise                        → textOnAction ONLY (it is the tan pill).
 *   ocean                          → textInverse ONLY (it is a pastel).
 *   shimmer / scrimDown            → overlays, not text grounds.
 */
export const gradients = {
  /** The cactus header. Muted sage settling into the ground. */
  olive: ['#3E4B37', '#34402F', '#2A3427'],
  /** Cactus ground lifting into the pipeline sky — a hero surface. */
  oliveSky: ['#2A3427', '#34402F', '#3B4F5E'],
  /** Warm call-to-action fill: pale sand into desert tan. */
  sunrise: ['#E2CBA3', '#D8B98A'],
  /** Sky into ocean. Water-cool counterweight to the sun ramp. */
  ocean: ['#A9C0D0', '#8DA9BD'],
  /** Almost-flat page wash. Use to fake depth cheaply. */
  cream: ['#1E1C1A', '#232019'],
  /** Neutral lifted surface when cactus would be too loud. */
  ink: ['#3D3833', '#2A2623'],
  /** Skeleton sweep: transparent → highlight → transparent. */
  shimmer: ['rgba(255,255,255,0)', 'rgba(255,255,255,0.10)', 'rgba(255,255,255,0)'],
  /** Bottom-of-photo scrim so caption text stays readable over any image. */
  scrimDown: ['rgba(0,0,0,0)', 'rgba(0,0,0,0.66)'],
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
