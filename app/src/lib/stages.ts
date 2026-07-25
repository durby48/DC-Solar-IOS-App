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

/** Pill colors per stage: background + text. */
export const STAGE_COLORS: Record<Stage, { bg: string; fg: string }> = {
  'Pending Estimate': { bg: colors.tan, fg: colors.inkSoft },
  'Pending Contract': { bg: colors.sunLight, fg: colors.inkSoft },
  'Pending Removal': { bg: colors.skySoft, fg: colors.ocean },
  'Pending Reinstall': { bg: colors.sky, fg: colors.ink },
  'Pending Permit': { bg: colors.cream, fg: colors.inkSoft },
  'Pending Payment': { bg: colors.sun, fg: colors.ink },
  Complete: { bg: colors.ocean, fg: colors.white },
};

/** Stage shown when a job predates migration 6 or has no stage set. */
export function stageOrDefault(
  stage: unknown,
  status?: string | null,
): Stage {
  if (isStage(stage)) return stage;
  return status === 'completed' ? 'Complete' : 'Pending Estimate';
}
