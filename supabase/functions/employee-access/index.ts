/**
 * employee-access — admins invite employees and manage their access
 * (2026-10-05). See supabase/migrations/2026-10-05_employee_invites.sql.
 *
 * POST { action, … } (verify_jwt ON; caller re-checked as owner/operator):
 *   statuses                → { employees: [{ email, has_login, last_sign_in_at,
 *                                             removed, invite_expires_at }] }
 *   invite { name, email, role: 'sales'|'viewer'|'operator',
 *            cell?, number?, pay_rate? }
 *                           → { link, expires_at }   (operator: owner only)
 *   link   { email }        → { link, expires_at, kind }  a fresh setup link,
 *                             or a password-reset link if they have a login
 *   remove { email }        → { ok }   owner only: they lose all access, their
 *                             records stay
 *
 * Links are https://app.dcsolarkc.com/join?code=<32 random bytes>; only the
 * SHA-256 of the code is stored, valid 7 days, single use (`accept-invite`).
 * No email is sent — the admin texts / copies / emails the link from the app,
 * because this project's Auth email only reaches the team (no custom SMTP).
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
const LINK_DAYS = 7;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_ROLES = ['sales', 'viewer', 'operator'];

function ok(payload: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function toE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function randomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface AuthUserLite {
  id: string;
  email: string;
  last_sign_in_at: string | null;
  banned_until: string | null;
}

/** Every Auth user, by lowercase email. A small company: one or two pages. */
async function authUsers(admin: SupabaseClient): Promise<Map<string, AuthUserLite>> {
  const map = new Map<string, AuthUserLite>();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Could not list accounts: ${error.message}`);
    for (const u of data.users) {
      if (!u.email) continue;
      map.set(u.email.toLowerCase(), {
        id: u.id,
        email: u.email,
        last_sign_in_at: u.last_sign_in_at ?? null,
        banned_until: (u as { banned_until?: string | null }).banned_until ?? null,
      });
    }
    if (data.users.length < 1000) break;
  }
  return map;
}

async function issueLink(
  admin: SupabaseClient,
  input: { email: string; name: string | null; kind: 'invite' | 'reset'; createdBy: string },
  appBase: string,
): Promise<{ link: string; expires_at: string }> {
  const now = new Date().toISOString();
  // Only the newest link works: anything still open for this person is revoked.
  await admin
    .from('employee_invites')
    .update({ revoked_at: now })
    .eq('company', COMPANY)
    .ilike('email', input.email)
    .is('used_at', null)
    .is('revoked_at', null);
  const code = randomCode();
  const expires = new Date(Date.now() + LINK_DAYS * 24 * 3600 * 1000).toISOString();
  const { error } = await admin.from('employee_invites').insert({
    company: COMPANY,
    email: input.email,
    display_name: input.name,
    kind: input.kind,
    token_hash: await sha256Hex(code),
    created_by: input.createdBy,
    expires_at: expires,
  });
  if (error) throw new Error(`Could not save the link: ${error.message}`);
  return { link: `${appBase}/join?code=${encodeURIComponent(code)}`, expires_at: expires };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const appBase = (Deno.env.get('APP_PUBLIC_BASE') ?? 'https://app.dcsolarkc.com').replace(/\/+$/, '');
    if (!supabaseUrl || !serviceKey) return fail(500, 'not_configured', 'Server is missing its Supabase settings.');
    const admin = createClient(supabaseUrl, serviceKey);

    // --- caller must be an admin ---------------------------------------------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const callerEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !callerEmail) return fail(401, 'unauthorized', 'Not signed in.');
    const { data: me } = await admin.from('employees').select('role').eq('company', COMPANY).ilike('email', callerEmail).maybeSingle();
    const myRole = (me as { role?: string } | null)?.role;
    const isOwner = myRole === 'owner';
    if (!isOwner && myRole !== 'operator') return fail(403, 'forbidden', 'Admins only.');

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = String(body.action ?? '');

    // --- statuses -------------------------------------------------------------
    if (action === 'statuses') {
      const [{ data: emps }, users, { data: invites }] = await Promise.all([
        admin.from('employees').select('email').eq('company', COMPANY),
        authUsers(admin),
        admin
          .from('employee_invites')
          .select('email, expires_at')
          .eq('company', COMPANY)
          .is('used_at', null)
          .is('revoked_at', null)
          .gt('expires_at', new Date().toISOString()),
      ]);
      const openInvite = new Map<string, string>();
      for (const i of (invites ?? []) as { email: string; expires_at: string }[]) {
        openInvite.set(i.email.toLowerCase(), i.expires_at);
      }
      const rows = ((emps ?? []) as { email: string }[]).map((e) => {
        const u = users.get(e.email.toLowerCase());
        return {
          email: e.email,
          has_login: Boolean(u),
          last_sign_in_at: u?.last_sign_in_at ?? null,
          invite_expires_at: openInvite.get(e.email.toLowerCase()) ?? null,
        };
      });
      return ok({ employees: rows });
    }

    // --- invite ---------------------------------------------------------------
    if (action === 'invite') {
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? '');
      if (!name) return fail(400, 'bad_request', 'A name is required.');
      if (!EMAIL_RE.test(email)) return fail(400, 'bad_request', 'That email address does not look right.');
      if (!INVITE_ROLES.includes(role)) return fail(400, 'bad_request', 'Pick a role: Sales, Crew or Operator.');
      if (role === 'operator' && !isOwner) return fail(403, 'forbidden', 'Only the owner can invite an operator (admin).');

      const { data: existing } = await admin.from('employees').select('id').ilike('email', email).maybeSingle();
      if (existing) return fail(409, 'exists', 'That person is already an employee — use "New link" on their row.');
      const users = await authUsers(admin);
      if (users.has(email)) {
        return fail(
          409,
          'has_account',
          'That email already has a DC Solar login (for example a customer-portal account). Use a different email for staff.',
        );
      }

      let payRate: number | null = null;
      if (body.pay_rate != null && String(body.pay_rate).trim() !== '') {
        payRate = Number(body.pay_rate);
        if (!Number.isFinite(payRate) || payRate < 0 || payRate > 500) return fail(400, 'bad_request', 'Pay rate should be dollars per hour.');
      }
      const cell = body.cell ? toE164(String(body.cell)) : null;
      if (body.cell && String(body.cell).trim() && !cell) return fail(400, 'bad_request', 'The cell number should be a 10-digit US number.');
      const number = body.number ? toE164(String(body.number)) : null;
      if (body.number && String(body.number).trim() && !number) return fail(400, 'bad_request', 'The DC Solar number should be a 10-digit US number.');

      const { error: empErr } = await admin.from('employees').insert({
        company: COMPANY,
        email,
        role,
        display_name: name,
        pay_rate: payRate,
        is_test: false,
      });
      if (empErr) return fail(500, 'save_failed', `Could not add the employee: ${empErr.message}`);

      if (cell) {
        await admin
          .from('staff_profiles')
          .upsert({ company: COMPANY, email, cell_phone: cell, updated_at: new Date().toISOString() }, { onConflict: 'company,email' });
      }
      if (number) {
        const { error: routeErr } = await admin
          .from('voice_routes')
          .upsert(
            { number_e164: number, company: COMPANY, assigned_to: email, label: role === 'sales' ? 'Sales rep' : name, updated_at: new Date().toISOString() },
            { onConflict: 'number_e164' },
          );
        if (routeErr) return fail(500, 'save_failed', `Employee added, but the phone number could not be assigned: ${routeErr.message}`);
      }

      const issued = await issueLink(admin, { email, name, kind: 'invite', createdBy: callerEmail }, appBase);
      return ok(issued);
    }

    // --- a fresh link (expired invite, or a password reset) -------------------
    if (action === 'link') {
      const email = String(body.email ?? '').trim().toLowerCase();
      const { data: emp } = await admin
        .from('employees')
        .select('email, display_name')
        .eq('company', COMPANY)
        .ilike('email', email)
        .maybeSingle();
      if (!emp) return fail(404, 'not_found', 'That person is not an employee.');
      const users = await authUsers(admin);
      const kind: 'invite' | 'reset' = users.has(email) ? 'reset' : 'invite';
      const issued = await issueLink(
        admin,
        { email, name: (emp as { display_name?: string | null }).display_name ?? null, kind, createdBy: callerEmail },
        appBase,
      );
      return ok({ ...issued, kind });
    }

    // --- remove access (owner only) -------------------------------------------
    if (action === 'remove') {
      if (!isOwner) return fail(403, 'forbidden', 'Only the owner can remove someone\'s access.');
      const email = String(body.email ?? '').trim().toLowerCase();
      if (email === callerEmail) return fail(400, 'bad_request', 'You cannot remove your own access.');
      const { data: emp } = await admin.from('employees').select('id, role').eq('company', COMPANY).ilike('email', email).maybeSingle();
      if (!emp) return fail(404, 'not_found', 'That person is not an employee.');
      if ((emp as { role?: string }).role === 'owner') return fail(400, 'bad_request', 'The owner cannot be removed here.');

      const now = new Date().toISOString();
      await admin.from('employee_invites').update({ revoked_at: now }).eq('company', COMPANY).ilike('email', email).is('used_at', null).is('revoked_at', null);
      // Their DC Solar number goes back to the pool for reassignment.
      await admin.from('voice_routes').delete().eq('company', COMPANY).ilike('assigned_to', email);
      const { error: delErr } = await admin.from('employees').delete().eq('id', (emp as { id: string }).id);
      if (delErr) return fail(500, 'save_failed', `Could not remove the employee: ${delErr.message}`);
      // Sign-in stops working too (data access already ended with the row).
      const users = await authUsers(admin);
      const u = users.get(email);
      if (u) await admin.auth.admin.updateUserById(u.id, { ban_duration: '876000h' });
      return ok({ removed: email });
    }

    return fail(400, 'bad_request', 'Unknown action.');
  } catch (e) {
    return fail(500, 'unexpected', e instanceof Error ? e.message : 'Unexpected error.');
  }
});
