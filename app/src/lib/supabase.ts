import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type Session, type User } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

import { getViewAsPerson, isDevViewLoaded, pushDevNotice, setDevViewState, whenDevViewLoaded } from '@/lib/devViewState';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseKey = process.env.EXPO_PUBLIC_SUPABASE_KEY ?? '';

/**
 * Developer "view as a person" (2026-10-08) — every request passes through
 * here. With nobody being viewed it is plain `fetch`. While a developer looks
 * through someone's eyes (lib/devViewState.ts):
 *
 *   database   gets `x-view-as` + `Prefer: tx=rollback`: the server's
 *              dev_pre_request() runs it AS that person and undoes it, so the
 *              screens show their data and a save answers "could they?"
 *              without saving (2026-10-08_developer.sql). `rpc/dev_*` are the
 *              developer's own tools and go through as the developer.
 *   functions  turned off, except the texting and calling checks, which ask
 *              the function "could they?" (`devViewAs`) and send nothing.
 *   storage    reads only; uploads and deletes are turned off.
 */
const DRY_RUN_FUNCTIONS = new Set(['twilio-send-sms', 'twilio-voice-token']);
// An RPC that changes something — for the "could they?" line. Reads stay quiet.
const WRITE_RPC =
  /^(set|book|assign|reschedule|cancel|record|import|create|update|delete|add|remove|mark|claim|take|send|save|upsert|insert|approve|reject|submit|log|complete|start|stop|clock|accept|archive|restore|move|convert|request|issue|link|unlink|toggle|reorder|apply|finish|close|reopen|dismiss|snooze|redeem|open_pack)/;

// Saves the app makes on its own (opening a thread marks it read; the phone
// registers for notifications) — still undone, but no "could they?" line.
const QUIET_WRITES = /^(rpc\/mark_messages_read|push_tokens)(\?|$)/;

function lookOnly(message: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, code: 'look_only', error: message, message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function errorText(res: Response): Promise<string> {
  const j = (await res.clone().json().catch(() => null)) as { message?: string; error?: string } | null;
  return j?.message ?? j?.error ?? `error ${res.status}`;
}

/**
 * Phone reports (2026-10-08): `lib/diagnostics.ts` registers here to hear
 * about requests that failed (5xx, or a 401/403 refusal) — the path and status
 * only, never the query string or body.
 */
type ProblemHook = (info: { path: string; method: string; status: number }) => void;
let problemHook: ProblemHook | null = null;
export function setRequestProblemHook(hook: ProblemHook | null): void {
  problemHook = hook;
}

async function watched(input: RequestInfo | URL, init: RequestInit | undefined, url: string, method: string): Promise<Response> {
  const res = await fetch(input, init);
  if (problemHook && (res.status >= 500 || res.status === 401 || res.status === 403) && !url.includes('client_diagnostics')) {
    const path = (url.split('.supabase.co')[1] ?? url).split('?')[0];
    try {
      problemHook({ path, method, status: res.status });
    } catch {
      // never let reporting break a request
    }
  }
  return res;
}

async function devFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
  // Sign-in and token refresh never wait: reading the saved view at launch
  // checks the session, which may itself need a refresh.
  if (url.includes('/auth/v1/')) {
    if (getViewAsPerson() && url.includes('/auth/v1/user') && method === 'PUT') {
      return lookOnly('Look-only while viewing as someone.', 403);
    }
    return fetch(input, init);
  }
  if (!isDevViewLoaded()) await whenDevViewLoaded();
  const person = getViewAsPerson();
  if (!person) return watched(input, init, url, method);

  const first = person.name.split(' ')[0] || person.name;

  if (url.includes('/rest/v1/')) {
    if (url.includes('/rest/v1/rpc/dev_')) return fetch(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set('x-view-as', person.email);
    const prefer = headers.get('Prefer');
    headers.set('Prefer', prefer ? `${prefer}, tx=rollback` : 'tx=rollback');
    const res = await fetch(input, { ...init, headers });
    // The server refused the view itself (the Developer tag was removed):
    // drop back to your own view rather than fail every screen.
    if (res.status === 401 || res.status === 403) {
      if ((await errorText(res)).startsWith('View as is for developers only')) {
        setDevViewState(null);
        void AsyncStorage.removeItem('dc.devView.v1').catch(() => {});
        return fetch(input, init);
      }
    }
    const path = url.split('/rest/v1/')[1]?.split('?')[0] ?? '';
    const isWrite =
      method !== 'GET' &&
      method !== 'HEAD' &&
      (!path.startsWith('rpc/') || WRITE_RPC.test(path.slice(4)));
    if (isWrite && !QUIET_WRITES.test(path)) {
      if (res.ok) pushDevNotice(true, `${first} could do this. Nothing was saved (look-only).`);
      else pushDevNotice(false, `${first} can't: ${await errorText(res)}`);
    }
    return res;
  }

  if (url.includes('/functions/v1/')) {
    const fn = url.split('/functions/v1/')[1]?.split(/[?/]/)[0] ?? '';
    if (DRY_RUN_FUNCTIONS.has(fn)) {
      let body: Record<string, unknown> = {};
      try {
        body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      } catch {
        body = {};
      }
      const headers = new Headers(init?.headers);
      headers.set('Content-Type', 'application/json');
      const res = await fetch(url, {
        ...init,
        method: 'POST',
        headers,
        body: JSON.stringify({ ...body, devViewAs: person.email }),
      });
      const json = (await res.clone().json().catch(() => null)) as { dryRun?: boolean; message?: string } | null;
      if (res.ok && json?.dryRun) {
        pushDevNotice(true, `${json.message ?? `${first} could do this.`} Nothing was sent (look-only).`);
        return lookOnly(`Look-only — nothing was sent. ${json.message ?? ''}`.trim(), 409);
      }
      pushDevNotice(false, `${first} can't: ${await errorText(res)}`);
      return res;
    }
    pushDevNotice(false, `Look-only: that action is turned off while viewing as ${first}.`);
    return lookOnly(`Look-only while viewing as ${person.name} — this action is turned off.`, 403);
  }

  if (url.includes('/storage/v1/')) {
    const read = method === 'GET' || method === 'HEAD' || /\/object\/(sign|list)\//.test(url);
    if (!read) {
      pushDevNotice(false, `Look-only: uploads and deletes are off while viewing as ${first}.`);
      return lookOnly(`Look-only while viewing as ${person.name} — uploads are turned off.`, 403);
    }
  }

  return fetch(input, init);
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { fetch: devFetch },
  auth: {
    // On web (including static prerender, where `window` is undefined),
    // let supabase-js use its SSR-safe default storage.
    ...(Platform.OS !== 'web' ? { storage: AsyncStorage } : {}),
    autoRefreshToken: true,
    persistSession: true,
    // Web only, and it is what makes the customer-portal invite work.
    //
    // We stay on the IMPLICIT flow (no PKCE): Supabase delivers invite,
    // recovery and email-confirm links to the browser as a URL *fragment*
    // (`.../set-password#access_token=…&refresh_token=…`). Nothing but
    // supabase-js reads that fragment — with this off, the tokens sat in the
    // address bar, no session was ever created, and every invited customer
    // landed on an empty "create your password" form that could not save.
    //
    // PKCE would put a `?code=` in the query instead, but it needs the code
    // verifier that was stored by the browser that STARTED the flow. Invites
    // start on the server, so there is no verifier — the exchange would fail.
    //
    // On native there is no URL to read; deep links are handled by the router,
    // so leave it off there (it also touches `window` during static prerender).
    detectSessionInUrl: Platform.OS === 'web',
  },
});

/**
 * "Who am I" while viewing as a person (2026-10-08): the screens find "me" in
 * ~40 places through the session's email/id, so the session is shown with the
 * viewed person's email and id. The access token stays the developer's own —
 * the server swaps identities itself, and only for a developer. Developer
 * Tools reads the real session through `getRealSession`.
 */
const NO_USER = '00000000-0000-0000-0000-000000000000';

function maskUser(user: User): User {
  const person = getViewAsPerson();
  if (!person) return user;
  return { ...user, email: person.email, id: person.uid ?? NO_USER };
}

function maskSession(session: Session | null): Session | null {
  if (!session || !getViewAsPerson()) return session;
  return { ...session, user: maskUser(session.user) };
}

const realGetSession = supabase.auth.getSession.bind(supabase.auth);
const realGetUser = supabase.auth.getUser.bind(supabase.auth);
const realOnAuthStateChange = supabase.auth.onAuthStateChange.bind(supabase.auth);

/** The developer's own session, unmasked. */
export const getRealSession = realGetSession;

supabase.auth.getSession = (async () => {
  if (!isDevViewLoaded()) await whenDevViewLoaded();
  const result = await realGetSession();
  if (!result.data.session || !getViewAsPerson()) return result;
  return { ...result, data: { session: maskSession(result.data.session) } };
}) as typeof supabase.auth.getSession;

supabase.auth.getUser = (async (jwt?: string) => {
  if (!isDevViewLoaded()) await whenDevViewLoaded();
  const result = await realGetUser(jwt);
  if (!result.data.user || !getViewAsPerson()) return result;
  return { ...result, data: { user: maskUser(result.data.user) } };
}) as typeof supabase.auth.getUser;

supabase.auth.onAuthStateChange = ((callback: Parameters<typeof realOnAuthStateChange>[0]) =>
  realOnAuthStateChange((event, session) => {
    if (isDevViewLoaded()) return callback(event, maskSession(session));
    void whenDevViewLoaded().then(() => callback(event, maskSession(session)));
  })) as typeof supabase.auth.onAuthStateChange;

/**
 * Keep the crew signed in across app switches (native only).
 *
 * `autoRefreshToken` runs on a JS timer, and iOS suspends that timer the moment
 * the app leaves the foreground. An access token lives one hour, so a phone
 * that sat in a pocket all morning came back holding an expired one; every
 * query then failed until something forced a refresh, which reads as "it logged
 * me out again". Supabase's own React Native guidance is to drive the refresher
 * from AppState instead of leaving it to that timer, so the refresh happens on
 * RESUME rather than on a schedule that iOS is free to ignore.
 *
 * Stopping it on background matters as much as starting it: a refresher firing
 * while suspended burns a rotated refresh token that the next resume then can't
 * use, and rotation is ON for this project
 * (`security_refresh_token_reuse_interval` = 10s).
 *
 * Web is exempt — the browser keeps its own timers alive and supabase-js
 * handles visibility there itself.
 */
if (Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      void supabase.auth.startAutoRefresh();
    } else {
      void supabase.auth.stopAutoRefresh();
    }
  });
}
