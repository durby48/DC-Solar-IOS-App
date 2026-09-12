import type { ComposeParams } from '@/lib/gmail';

/**
 * Hand a compose prefill to `/inbox/compose` without putting a quoted email
 * body in the URL.
 *
 * Route params travel through the URL on web, and a reply quotes the whole
 * original; Safari's address bar gives up around 80 KB. So the small fields
 * (to, subject, threadId…) go as params, where a reload keeps them, and the
 * body goes here under a one-shot key. If the key is gone — a reload, a
 * second tab — the composer opens with everything but the quote, which is a
 * shorter reply, not a broken one.
 */

const stash = new Map<string, ComposeParams>();
let counter = 0;

export function stashCompose(params: ComposeParams): string {
  counter += 1;
  const key = `c${Date.now().toString(36)}${counter}`;
  stash.set(key, params);
  // Never let an abandoned prefill live forever.
  setTimeout(() => stash.delete(key), 10 * 60_000);
  return key;
}

export function takeCompose(key: string | undefined): ComposeParams | null {
  if (!key) return null;
  const found = stash.get(key) ?? null;
  stash.delete(key);
  return found;
}

/** Params for `router.push`: every string field, undefined ones dropped, `text` stashed. */
export function composeRouteParams(params: ComposeParams): Record<string, string> {
  const out: Record<string, string> = {};
  const { text, ...rest } = params;
  for (const [k, v] of Object.entries(rest)) {
    if (typeof v === 'string' && v.length > 0) out[k] = v;
  }
  if (text) out.prefill = stashCompose({ text });
  return out;
}
