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
 */

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
