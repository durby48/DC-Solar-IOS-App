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
  // 2026-08-22: Complete moved ocean → olive. Ocean is Pending Install's hue,
  // so a solid ocean "Complete" pill sat two columns from a soft ocean
  // "Pending Install" pill and the board read as if half of it were finished.
  // Olive is the new brand lead and is 9.4:1 under cream, so it also gives
  // the one inverted pill the best contrast on the board.
  Complete: { bg: colors.olive, fg: colors.cream },
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
  Complete: colors.olive,
};

/**
 * Two-stop gradient per stage, for accent strips, progress fills and stage
 * hero surfaces (`components/ui`'s `GradientSurface` takes these directly).
 *
 * Every entry runs the same way — the soft chip tint at stop 0 into the
 * saturated hue at stop 1 — so a row of them reads as one system. That also
 * means the DEEP end is the dark end: put text at the soft end, or don't put
 * text on it at all. For a full olive hero surface use `gradients.olive`
 * from the theme instead; this map is about identifying a stage, not about
 * being a background for copy.
 */
export const STAGE_GRADIENT: Record<Stage, readonly [string, string]> = {
  'Pending Estimate': [colors.slateSoft, colors.slate],
  'Pending Contract': [colors.indigoSoft, colors.indigo],
  'Pending Removal': [colors.violetSoft, colors.violet],
  'Pending Reinstall': [colors.tealSoft, colors.teal],
  'Pending Install': [colors.skySoft, colors.ocean],
  'Pending Permit': [colors.amberSoft, colors.amber],
  'Pending Payment': [colors.coralSoft, colors.coral],
  Complete: [colors.oliveSoft, colors.olive],
};

/** Stage shown when a job predates migration 6 or has no stage set. */
export function stageOrDefault(
  stage: unknown,
  status?: string | null,
): Stage {
  if (isStage(stage)) return stage;
  return status === 'completed' ? 'Complete' : 'Pending Estimate';
}

/**
 * "Company" — the container job that holds overhead (DC-26026, DC Solar
 * Company). It is NOT a pipeline stage and deliberately not in STAGES.
 *
 * The label is derived from `jobs.is_internal`, which the app already treats as
 * the one way to say "this is overhead" (see financials.tsx). Making Company a
 * real stage would mean altering the jobs_stage_check constraint, adding it to
 * the job editor's picker so any job could be set to it, and letting the board's
 * ‹ › arrows move projects into it — none of which we want. It is a category,
 * not a step work moves through.
 */
export const COMPANY_LABEL = 'Company' as const;

/** A stage pill, or the Company pill for the overhead container. */
export type StageLabel = Stage | typeof COMPANY_LABEL;

/** True for the overhead container job. */
export function isCompanyJob(job: unknown): boolean {
  return (job as { is_internal?: boolean } | null)?.is_internal === true;
}

/**
 * What to show on a job's pill. Company wins over whatever stage the row
 * happens to carry — DC-26026 is stored as 'Complete' and showing that reads
 * as a finished project rather than the overhead bucket it is.
 */
export function labelForJob(job: {
  stage?: unknown;
  status?: string | null;
  is_internal?: boolean;
}): StageLabel {
  if (isCompanyJob(job)) return COMPANY_LABEL;
  return stageOrDefault(job.stage, job.status);
}

export const LABEL_COLORS: Record<StageLabel, { bg: string; fg: string }> = {
  ...STAGE_COLORS,
  // Warm neutral, deliberately unlike every pipeline hue: overhead is not a
  // step in the pipeline and shouldn't read as one.
  [COMPANY_LABEL]: { bg: colors.ink, fg: colors.cream },
};

export const LABEL_ACCENT: Record<StageLabel, string> = {
  ...STAGE_ACCENT,
  [COMPANY_LABEL]: colors.inkSoft,
};
