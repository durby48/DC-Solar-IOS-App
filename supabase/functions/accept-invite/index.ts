/**
 * accept-invite — the public end of an employee invite (2026-10-05).
 *
 * POST { action: 'check',  code }           → { name, email, kind }
 * POST { action: 'accept', code, password } → { email, mfa }  then the /join
 *                                              page signs in with that password
 *                                              (or, mfa, sends them to sign-in)
 *
 * PUBLIC (verify_jwt OFF): the person has no account yet. The code is the
 * credential — 32 random bytes from `employee-access`; only its SHA-256 is
 * stored. It must be unused, unrevoked, unexpired (7 days), and the person
 * must still be an employee (a removed person's link is dead).
 *
 * accept: claims the link first (used_at set where it is still null — two
 * tabs cannot both use it), then creates the Auth user with the chosen
 * password, or — kind 'reset', or a removed-then-reinvited person — sets the
 * password and lifts any ban. If that fails the claim is released so the link
 * can be retried. The employees row already exists, so handle_new_auth_user
 * files the account as staff, never as a customer.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
// The project's Auth policy: 8+ characters with upper, lower and a digit
// (Supabase also refuses breached passwords and says so in its own error).
const MIN_PASSWORD = 8;

function ok(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function findUser(admin: SupabaseClient, email: string): Promise<{ id: string } | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (hit) return { id: hit.id };
    if (data.users.length < 1000) return null;
  }
  return null;
}

interface InviteRow {
  id: string;
  email: string;
  display_name: string | null;
  kind: 'invite' | 'reset';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return fail(500, 'not_configured', 'Server is missing its settings.');
    const admin = createClient(supabaseUrl, serviceKey);

    const body = (await req.json().catch(() => ({}))) as { action?: string; code?: string; password?: string };
    const code = String(body.code ?? '').trim();
    if (code.length < 20) return fail(400, 'bad_link', 'This link is not complete. Ask DC Solar for a new one.');

    const { data } = await admin
      .from('employee_invites')
      .select('id, email, display_name, kind')
      .eq('company', COMPANY)
      .eq('token_hash', await sha256Hex(code))
      .is('used_at', null)
      .is('revoked_at', null)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    const invite = data as InviteRow | null;
    if (!invite) {
      return fail(410, 'expired', 'This link has expired or was already used. Ask DC Solar for a new one.');
    }
    const email = invite.email.toLowerCase();
    const { data: emp } = await admin.from('employees').select('id').eq('company', COMPANY).ilike('email', email).maybeSingle();
    if (!emp) return fail(410, 'expired', 'This link is no longer valid. Ask DC Solar for a new one.');

    if (body.action === 'check') {
      return ok({ name: invite.display_name, email, kind: invite.kind });
    }

    if (body.action !== 'accept') return fail(400, 'bad_request', 'Unknown action.');
    const password = String(body.password ?? '');
    if (password.length < MIN_PASSWORD || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
      return fail(400, 'weak_password', `Use at least ${MIN_PASSWORD} characters, with an uppercase letter, a lowercase letter and a number.`);
    }
    if (password.length > 72) return fail(400, 'weak_password', 'That password is too long (72 characters at most).');

    // Claim the link — only one use, even with two tabs open.
    const { data: claimed } = await admin
      .from('employee_invites')
      .update({ used_at: new Date().toISOString() })
      .eq('id', invite.id)
      .is('used_at', null)
      .select('id');
    if (!claimed || claimed.length === 0) {
      return fail(410, 'expired', 'This link was just used. Ask DC Solar for a new one if that was not you.');
    }

    const release = () => admin.from('employee_invites').update({ used_at: null }).eq('id', invite.id);
    const existing = await findUser(admin, email);
    // Someone who signs in with a 6-digit code (TOTP) must still give it: the
    // page then sends them to the normal sign-in instead of signing them in.
    let mfa = false;
    if (existing) {
      const { data: factors } = await admin.auth.admin.mfa.listFactors({ userId: existing.id });
      mfa = ((factors?.factors ?? []) as { status?: string }[]).some((f) => f.status === 'verified');
    }
    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, {
        password,
        ban_duration: 'none',
        email_confirm: true,
      });
      if (error) {
        await release();
        return fail(400, 'auth_error', error.message);
      }
    } else {
      const { error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: invite.display_name ? { full_name: invite.display_name } : {},
      });
      if (error) {
        await release();
        return fail(400, 'auth_error', error.message);
      }
    }

    return ok({ email, mfa });
  } catch (e) {
    return fail(500, 'unexpected', e instanceof Error ? e.message : 'Unexpected error.');
  }
});
