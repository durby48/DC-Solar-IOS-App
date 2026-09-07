/**
 * The Voice Access Token fetch, shared by every platform's `voice` module.
 *
 * WHY THIS IS ITS OWN FILE. `lib/voice.ts` has platform siblings
 * (`voice.web.ts`, `voice.native.ts`), and Metro applies platform resolution
 * to RELATIVE imports too: inside `voice.web.ts`, `import … from './voice'`
 * resolves to `voice.web.ts` — itself — and the module recursed until the
 * call stack overflowed ("Maximum call stack size exceeded", 2026-09-07,
 * every Phone screen on the web). Type-only imports are erased and survive;
 * a runtime import cannot live in a file that has platform variants. This
 * file has none, so all three can import it safely.
 */

import { supabase } from '@/lib/supabase';

/** The JSON body supabase-js hides on `error.context`. */
async function readPayload(error: unknown): Promise<{ code?: string; error?: string } | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  try {
    const response = context as Response;
    if (typeof response.clone === 'function') {
      return (await response.clone().json()) as { code?: string; error?: string };
    }
  } catch {
    // not JSON
  }
  return null;
}

/**
 * A fresh Voice Access Token from `twilio-voice-token`. A 503
 * `not_configured` here is the honest "in-app calling is not set up yet" the
 * call screen shows.
 */
export async function fetchVoiceToken(): Promise<
  { ok: true; token: string; identity: string } | { ok: false; code?: string; message: string }
> {
  try {
    const { data, error } = await supabase.functions.invoke('twilio-voice-token', { body: {} });
    if (error) {
      const payload = await readPayload(error);
      return {
        ok: false,
        code: payload?.code,
        message: payload?.error ?? error.message ?? 'Could not start the call.',
      };
    }
    const result = data as {
      ok?: boolean;
      token?: string;
      identity?: string;
      code?: string;
      error?: string;
    } | null;
    if (!result?.ok || !result.token) {
      return { ok: false, code: result?.code, message: result?.error ?? 'Could not start the call.' };
    }
    return { ok: true, token: result.token, identity: result.identity ?? '' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not start the call.' };
  }
}
