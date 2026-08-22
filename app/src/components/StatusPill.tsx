import { Pill } from '@/components/ui';
import {
  LABEL_COLORS,
  stageOrDefault,
  type Stage,
  type StageLabel,
} from '@/lib/stages';

/**
 * Pill showing a project's pipeline stage. Pass `stage` when known; legacy
 * callers that only have the jobs.status value can keep passing `status`,
 * which maps via stageOrDefault ('completed' → Complete, everything else →
 * Pending Estimate) so the whole app speaks the stage vocabulary.
 *
 * `stage` also accepts the Company label for the overhead container job — use
 * `labelForJob()` to resolve it, which prefers Company over the stored stage.
 *
 * 2026-08-22: the shape now comes from `components/ui`'s `Pill`; this file
 * keeps only the thing that is actually about stages — the `LABEL_COLORS`
 * lookup and the legacy `status` fallback. Its props are unchanged, so all
 * five call sites are untouched.
 */
export function StatusPill({
  stage,
  status,
}: {
  stage?: StageLabel | Stage | null;
  status?: string | null;
}) {
  const resolved = stage ?? stageOrDefault(undefined, status);
  const c = LABEL_COLORS[resolved];
  return <Pill label={resolved} bg={c.bg} fg={c.fg} />;
}
