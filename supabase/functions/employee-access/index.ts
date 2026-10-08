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
 *   link   { email, send_email? }
 *                           → { link, expires_at, kind, emailed?, email_error? }
 *                             a fresh setup link, or a password-reset link if
 *                             they have a login. send_email (2026-10-09) also
 *                             emails it to them from the company mailbox;
 *                             if the email fails the link is still returned.
 *   remove { email }        → { ok }   owner only: they lose all access, their
 *                             records stay
 *   numbers                 → { numbers: [{ number, texting_ready, calls_ready }] }
 *                             DC Solar's Twilio numbers that nobody has yet
 *                             (not in voice_routes) — the invite form's and the
 *                             Phone numbers card's dropdown. Read live from
 *                             Twilio, so a newly bought number just appears.
 *
 * Links are https://app.dcsolarkc.com/join?code=<32 random bytes>; only the
 * SHA-256 of the code is stored, valid 7 days, single use (`accept-invite`).
 * Supabase Auth email is NOT used — it only reaches the team (no custom SMTP).
 * Either the admin texts / copies the link from the app, or `send_email` sends
 * it through Gmail: the same service account (GMAIL_SA_JSON, domain-wide
 * delegation, gmail.modify) that gmail-inbox uses, impersonating
 * INVITE_EMAIL_FROM (default devon@dcsolarkc.com). It lands in that mailbox's
 * Sent, so there is a record of every link emailed.
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
const INVITE_ROLES = ['sales', 'sales_manager', 'viewer', 'operator'];

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

interface TwilioNumber {
  number: string;
  /** In the Messaging Service (A2P campaign) — texts will be delivered. */
  texting_ready: boolean;
  /** Has a "call comes in" webhook — calls reach the app. */
  calls_ready: boolean;
}

/** Every number on the Twilio account, flagged for half-done setup. */
async function twilioNumbers(): Promise<TwilioNumber[]> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const service = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID');
  if (!sid || !token) throw new Error('Twilio is not connected (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN).');
  const auth = `Basic ${btoa(`${sid}:${token}`)}`;
  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/IncomingPhoneNumbers.json?PageSize=200`,
    { headers: { authorization: auth } },
  );
  if (!res.ok) throw new Error(`Twilio said ${res.status} listing numbers.`);
  const data = (await res.json()) as {
    incoming_phone_numbers?: { sid: string; phone_number: string; voice_url: string | null; capabilities?: { sms?: boolean; voice?: boolean } }[];
  };
  const inService = new Set<string>();
  if (service) {
    const sres = await fetch(
      `https://messaging.twilio.com/v1/Services/${encodeURIComponent(service)}/PhoneNumbers?PageSize=200`,
      { headers: { authorization: auth } },
    );
    if (sres.ok) {
      const sdata = (await sres.json()) as { phone_numbers?: { sid: string }[] };
      for (const n of sdata.phone_numbers ?? []) inService.add(n.sid);
    }
  }
  return (data.incoming_phone_numbers ?? [])
    .filter((n) => n.capabilities?.voice !== false)
    .map((n) => ({
      number: n.phone_number,
      texting_ready: inService.has(n.sid),
      calls_ready: Boolean(n.voice_url && n.voice_url.trim()),
    }));
}

// --- emailing a link (2026-10-09) --------------------------------------------
// Same Google service account and scope as gmail-inbox; see its header for
// the delegation setup. Only the link email is sent from here.

const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64(text: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function gmailToken(mailbox: string): Promise<string> {
  const raw = Deno.env.get('GMAIL_SA_JSON');
  if (!raw) throw new Error('Email is not set up on the server (GMAIL_SA_JSON).');
  const sa = JSON.parse(raw) as { client_email?: string; private_key?: string };
  if (!sa.client_email || !sa.private_key) throw new Error('The email key on the server is incomplete.');
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(
    enc.encode(JSON.stringify({ iss: sa.client_email, sub: mailbox, scope: GMAIL_SCOPE, aud: GOOGLE_TOKEN_URL, iat: now, exp: now + 3600 })),
  );
  const der = atob(sa.private_key.replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, ''));
  const keyBytes = Uint8Array.from(der, (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', keyBytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`)));
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${b64url(signature)}`,
    }).toString(),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`Google refused the email login (${data.error ?? res.status}).`);
  return data.access_token;
}

/** Email a setup / reset link to the employee. Throws a readable message. */
async function emailLink(input: { to: string; name: string | null; link: string; kind: 'invite' | 'reset' }): Promise<void> {
  const from = (Deno.env.get('INVITE_EMAIL_FROM') ?? 'devon@dcsolarkc.com').trim();
  const first = (input.name ?? '').trim().split(' ')[0] || 'there';
  const subject = input.kind === 'reset' ? 'Reset your DC Solar password' : 'Welcome to DC Solar: set up your account';
  const text = [
    `Hi ${first},`,
    '',
    input.kind === 'reset'
      ? `Here is a link to set a new password for your DC Solar app account (${input.to}):`
      : `Welcome to DC Solar! Set up your app account (${input.to}) here:`,
    '',
    input.link,
    '',
    'The link works once and is good for 7 days.',
    input.kind === 'reset' ? 'If you did not ask for a new password, you can ignore this email; your current one still works.' : '',
    '',
    'DC Solar',
  ]
    .filter((line, i, all) => line !== '' || all[i - 1] !== '')
    .join('\n');
  // `to` passed EMAIL_RE (no whitespace, so no CR/LF); the subject is ASCII.
  const message = [
    `From: "DC Solar" <${from}>`,
    `To: ${input.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');
  const token = await gmailToken(from);
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: b64url(new TextEncoder().encode(message)) }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`Gmail did not send it (${data.error?.message ?? res.status}).`);
  }
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
    const { data: me } = await admin.from('employees').select('is_developer, role').eq('company', COMPANY).ilike('email', callerEmail).maybeSingle();
    // A developer (2026-10-08, employees.is_developer) may do anything an owner may.
    const myRole = (me as { is_developer?: boolean } | null)?.is_developer ? 'owner' : (me as { role?: string } | null)?.role;
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

    // --- numbers nobody has yet ------------------------------------------------
    if (action === 'numbers') {
      const [all, { data: routes }] = await Promise.all([
        twilioNumbers(),
        admin.from('voice_routes').select('number_e164').eq('company', COMPANY),
      ]);
      const taken = new Set(((routes ?? []) as { number_e164: string }[]).map((r) => r.number_e164));
      return ok({ numbers: all.filter((n) => !taken.has(n.number)) });
    }

    // --- invite ---------------------------------------------------------------
    if (action === 'invite') {
      const name = String(body.name ?? '').trim();
      const email = String(body.email ?? '').trim().toLowerCase();
      const role = String(body.role ?? '');
      if (!name) return fail(400, 'bad_request', 'A name is required.');
      if (!EMAIL_RE.test(email)) return fail(400, 'bad_request', 'That email address does not look right.');
      if (!INVITE_ROLES.includes(role)) return fail(400, 'bad_request', 'Pick a role: Sales, Sales manager, Crew or Operator.');
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

      if (number) {
        const [all, { data: route }] = await Promise.all([
          twilioNumbers(),
          admin.from('voice_routes').select('assigned_to').eq('number_e164', number).maybeSingle(),
        ]);
        if (!all.some((n) => n.number === number)) return fail(400, 'bad_request', 'That number is not one of DC Solar\'s Twilio numbers.');
        if (route) return fail(409, 'number_taken', 'That number already belongs to someone. Pick another, or buy more in Twilio.');
      }

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
        // INSERT, never upsert: a number someone already has is refused, so two
        // admins cannot hand out the same line (number_e164 is the key).
        const { error: routeErr } = await admin.from('voice_routes').insert({
          number_e164: number,
          company: COMPANY,
          assigned_to: email,
          label: role === 'sales' || role === 'sales_manager' ? `Sales — ${name}` : name,
        });
        if (routeErr) {
          const taken = /duplicate|unique/i.test(routeErr.message);
          return fail(
            taken ? 409 : 500,
            taken ? 'number_taken' : 'save_failed',
            taken
              ? `${name} was added, but that number was just given to someone else — assign another in CRM settings → Phone numbers.`
              : `${name} was added, but the phone number could not be assigned: ${routeErr.message}`,
          );
        }
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
      const name = (emp as { display_name?: string | null }).display_name ?? null;
      const issued = await issueLink(admin, { email, name, kind, createdBy: callerEmail }, appBase);
      if (body.send_email !== true) return ok({ ...issued, kind });
      if (!EMAIL_RE.test(email)) return ok({ ...issued, kind, emailed: false, email_error: 'Their email address does not look right.' });
      try {
        await emailLink({ to: email, name, link: issued.link, kind });
        return ok({ ...issued, kind, emailed: true });
      } catch (e) {
        // The link is good either way: the admin can still copy or text it.
        return ok({ ...issued, kind, emailed: false, email_error: e instanceof Error ? e.message : 'The email could not be sent.' });
      }
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
