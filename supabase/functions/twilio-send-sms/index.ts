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
 * CONSENT IS ENFORCED HERE, NOT IN THE UI. `customers.sms_opt_out_at` and
 * `leads.sms_opt_out_at` are set by twilio-inbound when someone replies STOP,
 * and this function refuses to send to them no matter what the client asks for.
 * A2P 10DLC registration is revocable and one text to someone who opted out is
 * how that happens.
 *
 * CONSENT ATTACHES TO THE NUMBER, NOT THE ROW. The destination is checked
 * against EVERY customer holding that phone_e164 and one opt-out among them is
 * enough to refuse — see customersSharingNumber() for what that fixes.
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
 * PICTURES (2026-09-06). Twilio fetches MMS media by URL; it does not accept
 * an upload. The client uploads to the private `job-photos` bucket under
 * `mms/` and passes STORAGE PATHS, never URLs. This function signs each path
 * with the service role (24 h, Twilio fetches once at send time) and sets
 * the `MediaUrl` params itself. If the client could pass a raw MediaUrl, any
 * admin session could make the company number send arbitrary internet
 * content to a customer — so a path that is not under `mms/` is refused.
 * The row keeps the paths in `media_urls`; the app signs them again at read
 * time, the way lib/artwork.ts does for pipeline cards.
 *
 * POST { customerId?, leadId?, contactId?, to?, body?, jobId?, templateKey?,
 *        mediaPaths?: string[] }
 *   → { ok: true, messageId, twilioSid, status }
 *   `body` may be empty when `mediaPaths` is not.
 */

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
/** Twilio's hard ceiling for one API request is 1600 characters. */
const MAX_BODY = 1600;
const E164_RE = /^\+[1-9]\d{7,14}$/;

/** Twilio's ceiling per message. */
const MAX_MEDIA = 10;
const MEDIA_BUCKET = 'job-photos';
/**
 * Only this prefix, only these characters, no `..`. The client chose the
 * path; the prefix is what stops it choosing somebody's insurance PDF.
 */
const MEDIA_PATH_RE = /^mms\/[A-Za-z0-9_\-]+(?:\/[A-Za-z0-9_\-]+)*\.(?:jpg|jpeg|png|gif|webp)$/i;
/** 24 hours. Twilio fetches at send time; the app re-signs for display. */
const MEDIA_SIGN_TTL = 86400;

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
  contactId?: string;
  to?: string;
  body?: string;
  jobId?: string;
  templateKey?: string;
  /** Storage paths under `mms/` in the job-photos bucket. Never URLs. */
  mediaPaths?: string[];
  /** Developer "view as" (2026-10-08): check as this employee, send nothing. */
  devViewAs?: string;
  /** Developer "view as a role" (2026-10-08): their power applies only in an Owner/Operator view. */
  devAsRole?: string;
}

interface NumberMatch {
  id: string;
  name: string | null;
  sms_opt_out_at: string | null;
}

/**
 * EVERY customer holding this number — not one of them.
 *
 * This used to be `.maybeSingle()` with no `.limit(1)`. Two customers sharing a
 * phone (a couple, a landlord and a tenant, the same person entered twice)
 * makes PostgREST answer PGRST116 "more than one row", supabase-js turns that
 * into data: null, and the caller read null as "nobody by that number" — so the
 * opt-out check was skipped on exactly the numbers most likely to have one.
 *
 * The rule is ANY match opted out means we do not send. Consent belongs to the
 * handset, not to the CRM row: the phone that received STOP is the phone that
 * would receive this text.
 */
async function customersSharingNumber(
  admin: SupabaseClient,
  e164: string,
): Promise<NumberMatch[]> {
  const { data } = await admin
    .from('customers')
    .select('id, name, sms_opt_out_at')
    .eq('company', COMPANY)
    .eq('phone_e164', e164)
    .order('created_at', { ascending: true });
  return (data as NumberMatch[] | null) ?? [];
}

function optedOutMessage(who: string): string {
  return (
    `${who} replied STOP and is opted out of texts. They have to text START to this ` +
    'number themselves before we can text them again.'
  );
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

    // --- caller must be a company admin, or a sales rep on their own record --
    // Sales (2026-10-05, B3): a rep texts the leads and customers that are
    // theirs — checked below once the destination is known — from their own
    // number (voice_routes). Never a bare number, a contact, or someone else's
    // record.
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const realEmail = userData?.user?.email?.toLowerCase();
    if (userErr || !realEmail) return fail(401, 'unauthorized', 'Not signed in.');

    // --- input --------------------------------------------------------------
    let payload: Payload;
    try {
      payload = (await req.json()) as Payload;
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }

    // Developer "view as" (2026-10-08): a developer looking through someone
    // else's eyes asks "could THEY send this?". Every check below runs as that
    // person, and the answer comes back just before anything is written or
    // sent — a dry run never texts anyone. Only a developer may ask.
    let callerEmail = realEmail;
    let dryRunName: string | null = null;
    const { data: realRow } = await admin
      .from('employees')
      .select('is_developer')
      .eq('email', realEmail)
      .maybeSingle();
    const isDeveloper = Boolean((realRow as { is_developer?: boolean } | null)?.is_developer);
    // A developer texts like an admin only while in an Owner/Operator view;
    // in their normal view they are their own role (2026-10-08).
    const devAdmin = isDeveloper && !payload.devViewAs && (payload.devAsRole === 'owner' || payload.devAsRole === 'operator');
    if (payload.devViewAs) {
      if (!isDeveloper) return fail(403, 'forbidden', 'Developers only.');
      callerEmail = payload.devViewAs.toLowerCase();
    }
    const { data: employee } = await admin
      .from('employees')
      .select('role, display_name')
      .eq('email', callerEmail)
      .maybeSingle();
    const role = (employee as { role?: string } | null)?.role;
    if (payload.devViewAs) {
      if (!employee) return fail(404, 'not_found', 'That person is not an employee.');
      dryRunName = (employee as { display_name?: string | null }).display_name ?? callerEmail;
    }
    // A sales manager (2026-10-07) texts like a rep, from their own number, but
    // on any lead and any sales-side customer — they run the team. A developer
    // texting as themselves texts like an admin, whatever their role.
    const isManager = role === 'sales_manager';
    const isSales = (role === 'sales' || isManager) && !devAdmin;
    if (role !== 'owner' && role !== 'operator' && !isSales && !devAdmin) {
      return fail(403, 'forbidden', 'Admins and sales only.');
    }

    let body = typeof payload.body === 'string' ? payload.body.trim() : '';

    if (isSales) {
      if (payload.contactId || (!payload.customerId && !payload.leadId)) {
        return fail(403, 'forbidden', 'Sales can text their own leads and customers only.');
      }
      if (payload.to) return fail(403, 'forbidden', 'Sales texts go to the number on the record.');
      if (isManager && payload.leadId) {
        // Any lead.
      } else if (isManager && payload.customerId) {
        // Any customer the sales side made: a service visit, or a booked lead.
        const { data: service } = await admin
          .from('jobs')
          .select('id')
          .eq('customer_id', payload.customerId)
          .in('job_type', ['Cleaning', 'Inspection'])
          .limit(1);
        if ((service ?? []).length === 0) return fail(403, 'forbidden', 'That customer is not on the sales side.');
      } else if (payload.leadId) {
        const { data: own } = await admin.from('leads').select('assigned_to').eq('id', payload.leadId).maybeSingle();
        if ((own as { assigned_to?: string | null } | null)?.assigned_to?.toLowerCase() !== callerEmail) {
          return fail(403, 'forbidden', 'That lead is not assigned to you.');
        }
      } else if (payload.customerId) {
        // Theirs = they sold one of its jobs, or it came from their lead —
        // the same rule as is_sales_rep_for_customer() in the database.
        const { data: sold } = await admin
          .from('jobs')
          .select('id')
          .eq('customer_id', payload.customerId)
          .ilike('sales_rep_email', callerEmail)
          .limit(1);
        let mine = (sold ?? []).length > 0;
        if (!mine) {
          const { data: jobRows } = await admin.from('jobs').select('id').eq('customer_id', payload.customerId);
          const jobIds = ((jobRows ?? []) as { id: string }[]).map((j) => j.id);
          if (jobIds.length > 0) {
            const { data: fromLead } = await admin
              .from('leads')
              .select('id')
              .in('converted_job_id', jobIds)
              .ilike('assigned_to', callerEmail)
              .limit(1);
            mine = (fromLead ?? []).length > 0;
          }
        }
        if (!mine) return fail(403, 'forbidden', 'That customer is not yours.');
      }
    }

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

    // --- pictures: shape-checked BEFORE any row is written -------------------
    const mediaPaths = Array.isArray(payload.mediaPaths)
      ? payload.mediaPaths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    if (mediaPaths.length > MAX_MEDIA) {
      return fail(400, 'bad_request', `That is ${mediaPaths.length} pictures; the limit is ${MAX_MEDIA}.`);
    }
    for (const path of mediaPaths) {
      if (path.includes('..') || !MEDIA_PATH_RE.test(path)) {
        return fail(400, 'bad_request', 'Pictures have to be uploaded through the app first.');
      }
    }

    if (!body && mediaPaths.length === 0) {
      return fail(400, 'bad_request', 'body is required.');
    }
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
    // The caller's own number when they have one (a rep's line in
    // voice_routes, B3); otherwise the company number. A rep's number must be
    // in the Messaging Service's sender pool, so the A2P campaign covers it.
    const { data: myRoute } = await admin
      .from('voice_routes')
      .select('number_e164')
      .eq('company', COMPANY)
      .ilike('assigned_to', callerEmail)
      .order('created_at')
      .limit(1);
    const myNumber = ((myRoute ?? []) as { number_e164: string }[])[0]?.number_e164 ?? null;
    const fromNumber = myNumber ?? Deno.env.get('TWILIO_FROM_NUMBER') ?? settings.from_number ?? null;
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
    let contactId: string | null = null;

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
        return fail(400, 'opted_out', optedOutMessage(who));
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
        .select('id, name, phone, phone_e164, sms_opt_out_at, call_first')
        .eq('id', payload.leadId)
        .maybeSingle();
      const lead = leadRow as {
        id: string;
        name: string | null;
        phone: string | null;
        phone_e164: string | null;
        sms_opt_out_at: string | null;
        call_first?: boolean;
      } | null;
      if (!lead) return fail(404, 'not_found', 'Lead not found.');
      who = lead.name ?? 'that lead';
      leadId = lead.id;
      // Leads get the same consent rule as customers. Until 2026-08-22 the
      // column did not exist, so a lead who replied STOP was recorded nowhere
      // and could be texted again the next day.
      if (lead.sms_opt_out_at) {
        return fail(400, 'opted_out', optedOutMessage(who));
      }
      // 2026-10-09 (Carson): imported leads are no longer blocked from texts
      // until a call. `call_first` stays on the lead (the CRM's "Call first"
      // filter still finds them); it just does not stop a send.
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
    } else if (payload.contactId) {
      // Suppliers / vendors (2026-09-06). No opt-out column: this is not A2P
      // traffic to a consumer, it is us texting the supply house.
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
      who = contact.name ?? 'that contact';
      contactId = contact.id;
      to = payload.to ? toE164(payload.to) : contact.phone_e164;
      if (!to) {
        return fail(
          400,
          'no_number',
          contact.phone
            ? `${who} has "${contact.phone}" on file, which is not a textable US number. Fix the phone number on the contact.`
            : `${who} has no phone number on file. Add one to the contact first.`,
        );
      }
    } else if (payload.to) {
      to = toE164(payload.to);
      if (!to) return fail(400, 'no_number', `"${payload.to}" is not a textable US number.`);
      who = to;
    } else {
      return fail(400, 'bad_request', 'Pass customerId, leadId, contactId or to.');
    }

    // --- consent on the NUMBER, whichever branch produced it -----------------
    // One check for all three branches, because the hazard is the same in all
    // three: the destination handset may belong to more than one CRM row, and
    // it only takes ONE of them to have replied STOP. This also catches an
    // explicit `to` that overrides a customer's number, and a lead whose number
    // is also on a customer record.
    const sharing = await customersSharingNumber(admin, to);
    const optedOut = sharing.find((c) => c.sms_opt_out_at);
    if (optedOut) {
      return fail(400, 'opted_out', optedOutMessage(optedOut.name ?? who));
    }
    // First (oldest) match is the one we file the message under, so a bare
    // number still lands in the right thread.
    if (!customerId && sharing.length > 0) {
      customerId = sharing[0].id;
      who = sharing[0].name ?? who;
    }

    // A developer's dry run stops here: every check passed, nothing written.
    if (dryRunName) {
      return ok({
        dryRun: true,
        message: `${dryRunName} could send this text to ${who}${fromNumber ? ` from ${fromNumber}` : ''}.`,
      });
    }

    // --- write the row FIRST, then hand it to Twilio ------------------------
    const { data: insertedRow, error: insertErr } = await admin
      .from('messages')
      .insert({
        company: COMPANY,
        customer_id: customerId,
        lead_id: leadId,
        contact_id: contactId,
        job_id: payload.jobId ?? null,
        channel: 'sms',
        direction: 'out',
        from_number: fromNumber,
        to_number: to,
        body,
        status: 'queued',
        sent_by: callerEmail,
        // Storage PATHS, not URLs — signed URLs expire, paths do not.
        media_urls: mediaPaths.length > 0 ? mediaPaths : null,
      })
      .select('id')
      .single();
    if (insertErr || !insertedRow) {
      return fail(500, 'server_error', `Could not log the message: ${insertErr?.message ?? 'insert failed'}`);
    }
    const messageId = (insertedRow as { id: string }).id;

    // --- sign the pictures for Twilio ------------------------------------------
    // After the row exists, so a signing failure is a logged "failed" send
    // rather than a message nobody can find later.
    const mediaUrls: string[] = [];
    for (const path of mediaPaths) {
      const { data: signed, error: signErr } = await admin.storage
        .from(MEDIA_BUCKET)
        .createSignedUrl(path, MEDIA_SIGN_TTL);
      if (signErr || !signed?.signedUrl) {
        const message = `Could not prepare a picture for sending: ${signErr?.message ?? 'no signed URL'}`;
        await admin
          .from('messages')
          .update({ status: 'failed', error_code: 'media', error: message })
          .eq('id', messageId);
        return fail(502, 'media_error', message);
      }
      mediaUrls.push(signed.signedUrl);
    }

    // --- Twilio -------------------------------------------------------------
    const form = new URLSearchParams();
    if (messagingServiceSid) form.set('MessagingServiceSid', messagingServiceSid);
    // With a Messaging Service, From pins the sender to that pool number (the
    // rep's own line); without one it is the only sender there is.
    if (myNumber || !messagingServiceSid) form.set('From', fromNumber!);
    form.set('To', to);
    // Twilio wants Body OR MediaUrl; an empty Body alongside pictures is fine
    // to omit and wrong to send as "".
    if (body) form.set('Body', body);
    for (const url of mediaUrls) form.append('MediaUrl', url);
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
