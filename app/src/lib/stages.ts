import { colors } from '@/constants/theme';

/**
 * Pipeline stages for a project. Stored in jobs.stage (added in migration 6).
 * The legacy jobs.status column ('active' | 'completed' | 'on_hold') is kept
 * in sync for the dcsolarkc.com ops console: Complete → 'completed',
 * everything else → 'active'.
 */
export const STAGES = [
  'Pending Estimate',
  'Pending Contract',
  'Pending Removal',
  'Pending Reinstall',
  'Pending Install',
  'Pending Permit',
  'Pending Payment',
  'Complete',
] as const;

export type Stage = (typeof STAGES)[number];

export function isStage(value: unknown): value is Stage {
  return typeof value === 'string' && (STAGES as readonly string[]).includes(value);
}

/** Legacy status value the ops console understands for a given stage. */
export function statusForStage(stage: Stage): 'active' | 'completed' {
  return stage === 'Complete' ? 'completed' : 'active';
}

/**
 * Pill colors per stage: background + text.
 *
 * Every stage owns a DISTINCT hue (2026-08-04 palette overhaul). Before this,
 * four stages shared two colors and the pipeline was unreadable at a glance.
 * Roughly ordered cool → warm as a job moves toward money changing hands, with
 * Complete as the only solid/inverted pill so finished work stands out.
 */
export const STAGE_COLORS: Record<Stage, { bg: string; fg: string }> = {
  'Pending Estimate': { bg: colors.slateSoft, fg: colors.slateDeep },
  'Pending Contract': { bg: colors.indigoSoft, fg: colors.indigoDeep },
  'Pending Removal': { bg: colors.violetSoft, fg: colors.violetDeep },
  'Pending Reinstall': { bg: colors.tealSoft, fg: colors.tealDeep },
  'Pending Install': { bg: colors.skySoft, fg: colors.ocean },
  'Pending Permit': { bg: colors.amberSoft, fg: colors.amberDeep },
  'Pending Payment': { bg: colors.coralSoft, fg: colors.coralDeep },
  Complete: { bg: colors.ocean, fg: colors.white },
};

/** Accent hue for a stage, used for art tinting and card accents. */
export const STAGE_ACCENT: Record<Stage, string> = {
  'Pending Estimate': colors.slate,
  'Pending Contract': colors.indigo,
  'Pending Removal': colors.violet,
  'Pending Reinstall': colors.teal,
  'Pending Install': colors.ocean,
  'Pending Permit': colors.amber,
  'Pending Payment': colors.coral,
  Complete: colors.mint,
};

/** Stage shown when a job predates migration 6 or has no stage set. */
export function stageOrDefault(
  stage: unknown,
  status?: string | null,
): Stage {
  if (isStage(stage)) return stage;
  return status === 'completed' ? 'Complete' : 'Pending Estimate';
}
