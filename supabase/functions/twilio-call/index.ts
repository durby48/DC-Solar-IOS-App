/**
 * twilio-call — place a bridge call so a customer sees the DC Solar number.
 *
 * HOW A BRIDGE CALL WORKS, because it reads backwards the first time:
 *
 *   1. the app asks for a call to a customer;
 *   2. Twilio rings the STAFF MEMBER'S OWN CELL first (staff_profiles.cell_phone);
 *   3. when they pick up, a short "Connecting you to <customer>" plays;
 *   4. Twilio then dials the customer with the business number as caller ID
 *      and bridges the two legs.
 *
 * The customer sees the DC Solar number, the crew member's personal number is
 * never exposed, and no VoIP SDK ships in the app — which is why this was
 * chosen over in-app calling for the first release.
 *
 * The call is logged as a `messages` row with channel = 'call'. Duration and
 * final state arrive later on twilio-status; that is why StatusCallback is set
 * here and why the row is keyed on the CallSid.
 *
 * Auth: verify_jwt ON plus a server-side admin re-check.
 *
 * Secrets: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
 * TWILIO_WEBHOOK_SECRET, TWILIO_PUBLIC_BASE. See docs/TWILIO_SETUP.md.
 *
 * POST { customerId?, to?, jobId? } → { ok: true, messageId, callSid }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
const E164_RE = /^\+[1-9]\d{7,14}$/;

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

function esc(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (E164_RE.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

interface Payload {
  customerId?: string;
  /** A supplier / vendor from `contacts` (2026-09-06). */
  contactId?: string;
  to?: string;
  jobId?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) {
      return fail(500, 'server_error', 'The function is missing its Supabase environment.');
    }
    const admin = createClient(supabaseUrl, serviceKey);

    // --- caller must be a company admin ------------------------------------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const callerEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !callerEmail) return fail(401, 'unauthorized', 'Not signed in.');
    const { data: employee } = await admin
      .from('employees')
      .select('role')
      .eq('email', callerEmail)
      .maybeSingle();
    const role = (employee as { role?: string } | null)?.role;
    if (role !== 'owner' && role !== 'operator') return fail(403, 'forbidden', 'Admins only.');

    // --- input --------------------------------------------------------------
    let payload: Payload;
    try {
      payload = (await req.json()) as Payload;
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }

    // --- is calling turned on? ----------------------------------------------
    const { data: settingsRow } = await admin
      .from('comms_settings')
      .select('voice_enabled, from_number')
      .eq('company', COMPANY)
      .maybeSingle();
    const settings = settingsRow as { voice_enabled?: boolean; from_number?: string | null } | null;
    if (!settings?.voice_enabled) {
      return fail(
        503,
        'not_configured',
        'Calling from the DC Solar number is turned off. Finish the Twilio setup ' +
          '(docs/TWILIO_SETUP.md), then switch "Calling" on in CRM settings.',
      );
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const fromNumber = Deno.env.get('TWILIO_FROM_NUMBER') ?? settings.from_number ?? null;
    const webhookSecret = Deno.env.get('TWILIO_WEBHOOK_SECRET');
    const publicBase = Deno.env.get('TWILIO_PUBLIC_BASE');

    if (!accountSid || !authToken) {
      return fail(
        503,
        'not_configured',
        'Twilio is not connected: set TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the ' +
          'edge functions. Steps are in docs/TWILIO_SETUP.md.',
      );
    }
    if (!fromNumber) {
      return fail(
        503,
        'not_configured',
        'No business number to call from: set TWILIO_FROM_NUMBER (the purchased 816/913 ' +
          'number, E.164) or fill in the number in CRM settings. See docs/TWILIO_SETUP.md.',
      );
    }

    // --- which phone do we ring first? --------------------------------------
    const { data: profileRow } = await admin
      .from('staff_profiles')
      .select('cell_phone, cell_phone_e164, voice_bridge_enabled')
      .eq('company', COMPANY)
      .eq('email', callerEmail)
      .maybeSingle();
    const profile = profileRow as {
      cell_phone: string | null;
      cell_phone_e164: string | null;
      voice_bridge_enabled: boolean | null;
    } | null;

    if (!profile?.cell_phone_e164) {
      return fail(
        400,
        'no_staff_number',
        profile?.cell_phone
          ? `Your cell number "${profile.cell_phone}" is not a valid US number. Fix it in CRM settings first.`
          : 'Add your cell number in CRM settings first.',
      );
    }
    if (profile.voice_bridge_enabled === false) {
      return fail(
        400,
        'bridge_disabled',
        'Bridge calling is switched off on your profile. Turn it back on in CRM settings.',
      );
    }
    const staffNumber = profile.cell_phone_e164;

    // --- who are we calling? -------------------------------------------------
    let to: string | null = null;
    let who = 'the customer';
    let customerId: string | null = payload.customerId ?? null;
    let contactId: string | null = null;

    if (payload.contactId) {
      const { data: contactRow } = await admin
        .from('contacts')
        .select('id, name, phone, phone_e164')
        .eq('id', payload.contactId)
        .maybeSingle();
      const contact = contactRow as {
        id: string;
        name: string | null;
        phone: string | null;
        phone_e164: string | null;
      } | null;
      if (!contact) return fail(404, 'not_found', 'Contact not found.');
      contactId = contact.id;
      who = contact.name ?? 'the contact';
      to = payload.to ? toE164(payload.to) : contact.phone_e164;
      if (!to) {
        return fail(
          400,
          'no_number',
          contact.phone
            ? `${who} has "${contact.phone}" on file, which is not a valid US number. Fix the phone number on the contact.`
            : `${who} has no phone number on file. Add one to the contact first.`,
        );
      }
    } else if (payload.customerId) {
      const { data: custRow } = await admin
        .from('customers')
        .select('id, name, phone, phone_e164')
        .eq('id', payload.customerId)
        .maybeSingle();
      const customer = custRow as {
        id: string;
        name: string | null;
        phone: string | null;
        phone_e164: string | null;
      } | null;
      if (!customer) return fail(404, 'not_found', 'Customer not found.');
      customerId = customer.id;
      who = customer.name ?? 'the customer';
      to = payload.to ? toE164(payload.to) : customer.phone_e164;
      if (!to) {
        return fail(
          400,
          'no_number',
          customer.phone
            ? `${who} has "${customer.phone}" on file, which is not a valid US number. Fix the phone number on their record.`
            : `${who} has no phone number on file. Add one on their customer record first.`,
        );
      }
    } else if (payload.to) {
      to = toE164(payload.to);
      if (!to) return fail(400, 'no_number', `"${payload.to}" is not a valid US number.`);
      who = to;
      // ALL of them, not one. `.maybeSingle()` with no `.limit(1)` answers
      // PGRST116 when two customers share a phone (a couple, a landlord and a
      // tenant, the same person entered twice), supabase-js turns that into
      // data: null, and the call was then logged against nobody — the thread
      // on that customer's record simply had no record of it.
      const { data: matchRows } = await admin
        .from('customers')
        .select('id, name')
        .eq('company', COMPANY)
        .eq('phone_e164', to)
        .order('created_at', { ascending: true });
      const matches = (matchRows as { id: string; name: string | null }[] | null) ?? [];
      if (matches.length > 0) {
        // Oldest match wins, so the call always lands in the same thread.
        // NOTE: sms_opt_out_at is deliberately NOT consulted. STOP is a
        // messaging opt-out; it does not mean "never phone me", and refusing to
        // dial somebody who asked us to stop TEXTING would be a bug, not
        // compliance. twilio-send-sms is where that flag decides anything.
        customerId = customerId ?? matches[0].id;
        who = matches[0].name ?? who;
      } else {
        // Not a customer — maybe the supply house, dialled from the keypad.
        // Filing it under the contact is what makes Recents show a name.
        const { data: contactRows } = await admin
          .from('contacts')
          .select('id, name')
          .eq('company', COMPANY)
          .eq('phone_e164', to)
          .is('archived_at', null)
          .order('created_at', { ascending: true })
          .limit(1);
        const contact = (contactRows as { id: string; name: string | null }[] | null)?.[0];
        if (contact) {
          contactId = contact.id;
          who = contact.name ?? who;
        }
      }
    } else {
      return fail(400, 'bad_request', 'Pass customerId, contactId or to.');
    }

    // --- the bridge ----------------------------------------------------------
    // answerOnBridge keeps the staff member hearing real ringback until the
    // customer actually picks up, instead of silence.
    const twiml =
      `<Response>` +
      `<Say voice="alice">Connecting you to ${esc(who)}. Please hold.</Say>` +
      `<Dial answerOnBridge="true" callerId="${esc(fromNumber)}" timeout="30">` +
      `<Number>${esc(to)}</Number>` +
      `</Dial>` +
      `</Response>`;

    const form = new URLSearchParams();
    form.set('To', staffNumber);
    form.set('From', fromNumber);
    form.set('Twiml', twiml);
    if (publicBase && webhookSecret) {
      form.set(
        'StatusCallback',
        `${publicBase.replace(/\/+$/, '')}/twilio-status?k=${encodeURIComponent(webhookSecret)}`,
      );
      form.set('StatusCallbackEvent', 'completed');
      form.set('StatusCallbackMethod', 'POST');
    }

    let callSid: string | null = null;
    let status = 'queued';
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`,
        {
          method: 'POST',
          headers: {
            authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: form.toString(),
        },
      );
      const result = (await res.json()) as {
        sid?: string;
        status?: string;
        code?: number;
        message?: string;
      };
      if (!res.ok) {
        const message = result.message ?? `Twilio rejected the call (${res.status}).`;
        // Log the failed attempt so "why did nothing happen" has an answer in
        // the thread rather than only in a toast that has already gone.
        await admin.from('messages').insert({
          company: COMPANY,
          customer_id: customerId,
          contact_id: contactId,
          job_id: payload.jobId ?? null,
          channel: 'call',
          direction: 'out',
          from_number: fromNumber,
          to_number: to,
          body: 'Bridge call',
          status: 'failed',
          error_code: result.code != null ? String(result.code) : String(res.status),
          error: message,
          sent_by: callerEmail,
        });
        return fail(502, 'twilio_error', message);
      }
      callSid = result.sid ?? null;
      status = result.status ?? 'queued';
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not reach Twilio.';
      return fail(502, 'twilio_error', message);
    }

    const { data: insertedRow, error: insertErr } = await admin
      .from('messages')
      .insert({
        company: COMPANY,
        customer_id: customerId,
        contact_id: contactId,
        job_id: payload.jobId ?? null,
        channel: 'call',
        direction: 'out',
        from_number: fromNumber,
        to_number: to,
        body: 'Bridge call',
        status,
        twilio_sid: callSid,
        sent_by: callerEmail,
      })
      .select('id')
      .single();

    // The call is already ringing; a logging failure is reported, not fatal.
    if (insertErr || !insertedRow) {
      return ok({
        messageId: null,
        callSid,
        warning: `The call is connecting but could not be logged: ${insertErr?.message ?? 'insert failed'}`,
      });
    }

    return ok({ messageId: (insertedRow as { id: string }).id, callSid });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Call failed.');
  }
});
