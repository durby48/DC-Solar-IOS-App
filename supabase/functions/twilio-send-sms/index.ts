/**
 * twilio-send-sms — send one text from the DC Solar business number.
 *
 * WHY THIS EXISTS
 *
 * Before this, texting a customer meant somebody using their personal cell.
 * The reply went to that phone, nobody else could see it, and when that person
 * was on a roof it sat unread. Every outbound text now leaves from ONE business
 * number and lands in `messages`, which is the shared inbox.
 *
 * THE ROW IS WRITTEN BEFORE TWILIO IS CALLED. That order is deliberate: if the
 * Twilio call times out we still have a record that a send was attempted, and
 * the status callback (twilio-status) can find the row by SID later. Writing
 * the row afterwards would lose the message on exactly the failure that
 * matters.
 *
 * CONSENT IS ENFORCED HERE, NOT IN THE UI. `customers.sms_opt_out_at` is set by
 * twilio-inbound when someone replies STOP, and this function refuses to send
 * to that customer no matter what the client asks for. A2P 10DLC registration
 * is revocable and one text to someone who opted out is how that happens.
 *
 * Auth: verify_jwt ON plus a server-side admin re-check. Message threads carry
 * prices and addresses; `messages` is admin-only on all four verbs and this
 * function matches it.
 *
 * Secrets (none exist until Devon finishes the Twilio setup — see
 * docs/TWILIO_SETUP.md):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN
 *   TWILIO_MESSAGING_SERVICE_SID  (preferred sender — carries the A2P campaign)
 *   TWILIO_FROM_NUMBER            (the purchased 816/913 number, E.164)
 *   TWILIO_WEBHOOK_SECRET         (the ?k= guard on the callback URLs)
 *   TWILIO_PUBLIC_BASE            (https://<ref>.supabase.co/functions/v1)
 *
 * POST { customerId?, leadId?, to?, body, jobId?, templateKey? }
 *   → { ok: true, messageId, twilioSid, status }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
/** Twilio's hard ceiling for one API request is 1600 characters. */
const MAX_BODY = 1600;
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

/** Loose US normalisation, matching the generated phone_e164 columns. */
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
  leadId?: string;
  to?: string;
  body?: string;
  jobId?: string;
  templateKey?: string;
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

    let body = typeof payload.body === 'string' ? payload.body.trim() : '';

    // A template key with no body: use the stored text, but only when it has no
    // unresolved merge fields. Filling {{address}} needs the client's context;
    // sending a customer literal braces is worse than refusing.
    if (!body && payload.templateKey) {
      const { data: tpl } = await admin
        .from('message_templates')
        .select('body')
        .eq('company', COMPANY)
        .eq('key', payload.templateKey)
        .maybeSingle();
      const tplBody = (tpl as { body?: string } | null)?.body ?? '';
      if (!tplBody) {
        return fail(400, 'bad_request', `There is no message template called "${payload.templateKey}".`);
      }
      if (/\{\{/.test(tplBody)) {
        return fail(
          400,
          'bad_request',
          `The "${payload.templateKey}" template has merge fields — fill them in the app and send the finished text.`,
        );
      }
      body = tplBody;
    }

    if (!body) return fail(400, 'bad_request', 'body is required.');
    if (body.length > MAX_BODY) {
      return fail(400, 'bad_request', `That text is ${body.length} characters; the limit is ${MAX_BODY}.`);
    }

    // --- settings: is texting turned on at all? -----------------------------
    const { data: settingsRow } = await admin
      .from('comms_settings')
      .select('sms_enabled, from_number')
      .eq('company', COMPANY)
      .maybeSingle();
    const settings = settingsRow as { sms_enabled?: boolean; from_number?: string | null } | null;
    if (!settings?.sms_enabled) {
      return fail(
        503,
        'not_configured',
        'Texting is turned off. Finish the Twilio setup (docs/TWILIO_SETUP.md), then switch ' +
          '"Text messaging" on in CRM settings.',
      );
    }

    const accountSid = Deno.env.get('TWILIO_ACCOUNT_SID');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID');
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
    if (!messagingServiceSid && !fromNumber) {
      return fail(
        503,
        'not_configured',
        'No sender: set TWILIO_MESSAGING_SERVICE_SID (preferred — it carries the A2P ' +
          'campaign) or TWILIO_FROM_NUMBER. See docs/TWILIO_SETUP.md.',
      );
    }

    // --- resolve the destination -------------------------------------------
    let to: string | null = null;
    let who = 'that contact';
    let customerId: string | null = payload.customerId ?? null;
    let leadId: string | null = payload.leadId ?? null;

    if (payload.customerId) {
      const { data: custRow } = await admin
        .from('customers')
        .select('id, name, phone, phone_e164, sms_opt_out_at')
        .eq('id', payload.customerId)
        .maybeSingle();
      const customer = custRow as {
        id: string;
        name: string | null;
        phone: string | null;
        phone_e164: string | null;
        sms_opt_out_at: string | null;
      } | null;
      if (!customer) return fail(404, 'not_found', 'Customer not found.');
      who = customer.name ?? 'that customer';
      customerId = customer.id;
      // Opt-out beats everything, including an explicit `to`.
      if (customer.sms_opt_out_at) {
        return fail(
          400,
          'opted_out',
          `${who} replied STOP and is opted out of texts. They have to text START to this ` +
            'number themselves before we can text them again.',
        );
      }
      to = payload.to ? toE164(payload.to) : customer.phone_e164;
      if (!to) {
        return fail(
          400,
          'no_number',
          customer.phone
            ? `${who} has "${customer.phone}" on file, which is not a textable US number. Fix the phone number on their record.`
            : `${who} has no phone number on file. Add one on their customer record first.`,
        );
      }
    } else if (payload.leadId) {
      const { data: leadRow } = await admin
        .from('leads')
        .select('id, name, phone, phone_e164')
        .eq('id', payload.leadId)
        .maybeSingle();
      const lead = leadRow as {
        id: string;
        name: string | null;
        phone: string | null;
        phone_e164: string | null;
      } | null;
      if (!lead) return fail(404, 'not_found', 'Lead not found.');
      who = lead.name ?? 'that lead';
      leadId = lead.id;
      to = payload.to ? toE164(payload.to) : lead.phone_e164;
      if (!to) {
        return fail(
          400,
          'no_number',
          lead.phone
            ? `${who} has "${lead.phone}" on file, which is not a textable US number. Fix the phone number on the lead.`
            : `${who} has no phone number on file. Add one on the lead first.`,
        );
      }
    } else if (payload.to) {
      to = toE164(payload.to);
      if (!to) return fail(400, 'no_number', `"${payload.to}" is not a textable US number.`);
      who = to;
      // A bare number might still belong to somebody who opted out — check.
      const { data: matchRow } = await admin
        .from('customers')
        .select('id, name, sms_opt_out_at')
        .eq('company', COMPANY)
        .eq('phone_e164', to)
        .maybeSingle();
      const match = matchRow as { id: string; name: string | null; sms_opt_out_at: string | null } | null;
      if (match) {
        customerId = customerId ?? match.id;
        who = match.name ?? who;
        if (match.sms_opt_out_at) {
          return fail(
            400,
            'opted_out',
            `${who} replied STOP and is opted out of texts. They have to text START to this ` +
              'number themselves before we can text them again.',
          );
        }
      }
    } else {
      return fail(400, 'bad_request', 'Pass customerId, leadId or to.');
    }

    // --- write the row FIRST, then hand it to Twilio ------------------------
    const { data: insertedRow, error: insertErr } = await admin
      .from('messages')
      .insert({
        company: COMPANY,
        customer_id: customerId,
        lead_id: leadId,
        job_id: payload.jobId ?? null,
        channel: 'sms',
        direction: 'out',
        from_number: fromNumber,
        to_number: to,
        body,
        status: 'queued',
        sent_by: callerEmail,
      })
      .select('id')
      .single();
    if (insertErr || !insertedRow) {
      return fail(500, 'server_error', `Could not log the message: ${insertErr?.message ?? 'insert failed'}`);
    }
    const messageId = (insertedRow as { id: string }).id;

    // --- Twilio -------------------------------------------------------------
    const form = new URLSearchParams();
    if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
    else form.set('From', fromNumber!);
    form.set('To', to);
    form.set('Body', body);
    if (publicBase && webhookSecret) {
      form.set(
        'StatusCallback',
        `${publicBase.replace(/\/+$/, '')}/twilio-status?k=${encodeURIComponent(webhookSecret)}`,
      );
    }

    let twilioSid: string | null = null;
    let status = 'queued';
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
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
        num_segments?: string;
        code?: number;
        message?: string;
      };

      if (!res.ok) {
        // Twilio's own wording is the most useful thing we can show ("The
        // 'To' number is not a valid mobile number"), so return it verbatim.
        const message = result.message ?? `Twilio rejected the message (${res.status}).`;
        await admin
          .from('messages')
          .update({
            status: 'failed',
            error_code: result.code != null ? String(result.code) : String(res.status),
            error: message,
          })
          .eq('id', messageId);
        return fail(502, 'twilio_error', message);
      }

      twilioSid = result.sid ?? null;
      status = result.status ?? 'queued';
      await admin
        .from('messages')
        .update({
          twilio_sid: twilioSid,
          status,
          num_segments: result.num_segments ? Number(result.num_segments) : null,
        })
        .eq('id', messageId);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Could not reach Twilio.';
      await admin
        .from('messages')
        .update({ status: 'failed', error_code: 'network', error: message })
        .eq('id', messageId);
      return fail(502, 'twilio_error', message);
    }

    return ok({ messageId, twilioSid, status });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Send failed.');
  }
});
