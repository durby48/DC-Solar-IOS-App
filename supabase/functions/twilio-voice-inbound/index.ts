/**
 * twilio-voice-inbound — what happens when a CUSTOMER CALLS the DC Solar
 * number (2026-09-08). The number's "A call comes in" webhook points here
 * (docs/TWILIO_SETUP.md § 8); until then Twilio's demo answers, which is
 * what has been happening since the number was bought.
 *
 * THE RING ORDER
 *   1. the app, as a real iPhone call (CallKit) on every admin's phone that
 *      has registered for incoming calls — simultaneous ring, first to
 *      answer wins. Only attempted when the push credential exists.
 *   2. the owner's cell (staff_profiles.cell_phone_e164), if nobody answered
 *      in the app or the app path is not configured.
 *   3. a short spoken apology and a hang-up. No voicemail yet.
 *
 * Every step is one Twilio request to this function with `?step=`:
 *   (none)   the call arrived → log it, identify the caller, <Dial> step 1
 *   app      the app dial finished → if not answered, <Dial> the cell
 *   cell     the cell dial finished → if not answered, say sorry, mark missed,
 *            push "📞 Missed call" to the admins with a target that opens
 *            the caller's thread
 *
 * SAME TWO GATES AS twilio-inbound / twilio-voice-outbound: `?k=` (401) and
 * X-Twilio-Signature (403). The caller is identified like an inbound text
 * (customers → leads → contacts by phone_e164) and CallKit shows that name
 * through <Parameter name="displayName">. One `messages` row per call
 * (channel call, direction in, twilio_sid = the inbound CallSid); the dialed
 * legs report to twilio-status via ParentCallSid, so the row ends up with the
 * outcome and the duration whichever way the call went.
 *
 * Deployed with verify_jwt FALSE. Secrets: TWILIO_AUTH_TOKEN,
 * TWILIO_WEBHOOK_SECRET, TWILIO_PUBLIC_BASE, TWILIO_FROM_NUMBER, NOTIFY_SECRET,
 * TWILIO_PUSH_CREDENTIAL_SID (presence only — it decides whether step 1 runs).
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-twilio-signature',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const COMPANY = 'dc-solar';
const E164_RE = /^\+[1-9]\d{7,14}$/;
const APP_RING_SECONDS = 25;
const CELL_RING_SECONDS = 25;

function xml(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/xml; charset=utf-8', ...CORS_HEADERS },
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

function sayAndHangUp(message: string): Response {
  return xml(`<Response><Say voice="alice">${esc(message)}</Say><Hangup/></Response>`);
}

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function twilioSignature(authToken: string, url: string, params: [string, string][]): Promise<string> {
  const sorted = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let payload = url;
  for (const [key, value] of sorted) payload += key + value;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (E164_RE.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function pretty(e164: string): string {
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

interface Caller {
  who: string;
  customerId: string | null;
  leadId: string | null;
  contactId: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only');

  try {
    const webhookSecret = Deno.env.get('TWILIO_WEBHOOK_SECRET');
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    const publicBase = Deno.env.get('TWILIO_PUBLIC_BASE');
    const fromNumber = Deno.env.get('TWILIO_FROM_NUMBER');
    if (!webhookSecret || !authToken || !publicBase || !fromNumber) {
      return fail(503, 'not_configured', 'Twilio is not connected yet. See docs/TWILIO_SETUP.md.');
    }

    // --- gate 1: the shared secret in the URL -------------------------------
    const url = new URL(req.url);
    if (!constantTimeEqual(url.searchParams.get('k') ?? '', webhookSecret)) {
      return fail(401, 'unauthorized', 'Bad or missing webhook key.');
    }

    const raw = await req.text();
    const form = new URLSearchParams(raw);
    const params: [string, string][] = [...form.entries()];

    // --- gate 2: the Twilio signature ---------------------------------------
    // The action URLs carry `step=` (and nothing else varies), so the signed
    // URL is exactly what Twilio was given: this function's URL + its query.
    const given = req.headers.get('X-Twilio-Signature') ?? '';
    if (!given) return fail(403, 'forbidden', 'Missing X-Twilio-Signature.');
    const base = publicBase.replace(/\/+$/, '');
    const self = `${base}/twilio-voice-inbound`;
    const candidates = [`${self}${url.search}`, `${self}?k=${webhookSecret}`, `${self}?k=${encodeURIComponent(webhookSecret)}`];
    let signatureOk = false;
    for (const candidate of candidates) {
      if (constantTimeEqual(await twilioSignature(authToken, candidate, params), given)) {
        signatureOk = true;
        break;
      }
    }
    if (!signatureOk) return fail(403, 'forbidden', 'Bad Twilio signature.');

    // --- genuinely Twilio from here ------------------------------------------
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !serviceKey) return sayAndHangUp('Sorry, we cannot take your call right now.');
    const admin = createClient(supabaseUrl, serviceKey);

    const callSid = form.get('CallSid') ?? '';
    const from = toE164(form.get('From') ?? '');
    const step = url.searchParams.get('step') ?? '';
    const k = encodeURIComponent(webhookSecret);
    const statusUrl = `${base}/twilio-status?k=${k}`;

    // --- who is calling ---------------------------------------------------------
    const identify = async (): Promise<Caller> => {
      const caller: Caller = { who: from ? pretty(from) : 'Unknown caller', customerId: null, leadId: null, contactId: null };
      if (!from) return caller;
      const { data: c } = await admin.from('customers').select('id, name').eq('company', COMPANY).eq('phone_e164', from).order('created_at').limit(1);
      const customer = (c as { id: string; name: string | null }[] | null)?.[0];
      if (customer) return { ...caller, customerId: customer.id, who: customer.name ?? caller.who };
      const { data: l } = await admin.from('leads').select('id, name').eq('company', COMPANY).eq('phone_e164', from).order('created_at').limit(1);
      const lead = (l as { id: string; name: string | null }[] | null)?.[0];
      if (lead) return { ...caller, leadId: lead.id, who: lead.name ?? caller.who };
      const { data: k2 } = await admin.from('contacts').select('id, name').eq('company', COMPANY).eq('phone_e164', from).is('archived_at', null).order('created_at').limit(1);
      const contact = (k2 as { id: string; name: string | null }[] | null)?.[0];
      if (contact) return { ...caller, contactId: contact.id, who: contact.name ?? caller.who };
      return caller;
    };

    // --- the owner's cell, the fallback ----------------------------------------
    const ownerCell = async (): Promise<string | null> => {
      const { data: owners } = await admin.from('employees').select('email').eq('company', COMPANY).eq('role', 'owner').eq('is_test', false);
      const emails = ((owners as { email: string }[] | null) ?? []).map((o) => o.email.toLowerCase());
      if (emails.length === 0) return null;
      const { data: profiles } = await admin
        .from('staff_profiles')
        .select('email, cell_phone_e164, voice_bridge_enabled')
        .eq('company', COMPANY)
        .in('email', emails);
      const p = ((profiles as { cell_phone_e164: string | null; voice_bridge_enabled: boolean }[] | null) ?? []).find(
        (row) => row.cell_phone_e164 && row.voice_bridge_enabled !== false,
      );
      return p?.cell_phone_e164 ?? null;
    };

    const dialCell = async (): Promise<Response> => {
      const cell = await ownerCell();
      if (!cell) return finish(await identify(), 'no-answer');
      return xml(
        `<Response>` +
          `<Dial callerId="${esc(from ?? fromNumber)}" timeout="${CELL_RING_SECONDS}" answerOnBridge="true" action="${esc(`${self}?k=${k}&step=cell`)}" method="POST">` +
          `<Number statusCallback="${esc(statusUrl)}" statusCallbackEvent="completed" statusCallbackMethod="POST">${esc(cell)}</Number>` +
          `</Dial>` +
          `</Response>`,
      );
    };

    /** The call is over without an answer: mark it, tell the admins, apologise. */
    const finish = async (caller: Caller, status: string): Promise<Response> => {
      if (callSid) {
        await admin.from('messages').update({ status }).eq('twilio_sid', callSid);
      }
      const notifySecret = Deno.env.get('NOTIFY_SECRET');
      if (notifySecret) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/notify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-notify-secret': notifySecret },
            body: JSON.stringify({
              title: '📞 Missed call',
              body: `${caller.who}${from && caller.who !== pretty(from) ? ` · ${pretty(from)}` : ''}`,
              audience: 'admins',
              target: {
                type: 'call',
                ...(caller.customerId ? { customerId: caller.customerId } : {}),
                ...(caller.leadId ? { leadId: caller.leadId } : {}),
                ...(caller.contactId ? { contactId: caller.contactId } : {}),
                ...(from ? { phone: from } : {}),
                name: caller.who,
              },
            }),
          });
        } catch {
          // The push is a courtesy; the call row is the record.
        }
      }
      return sayAndHangUp(
        'Sorry, nobody at DC Solar could pick up right now. Please send us a text at this number and we will get right back to you.',
      );
    };

    // ---- step: the app dial finished ---------------------------------------------
    if (step === 'app') {
      const outcome = form.get('DialCallStatus') ?? '';
      if (outcome === 'completed') return xml('<Response/>');
      return dialCell();
    }

    // ---- step: the cell dial finished --------------------------------------------
    if (step === 'cell') {
      const outcome = form.get('DialCallStatus') ?? '';
      if (outcome === 'completed') return xml('<Response/>');
      return finish(await identify(), outcome === 'busy' ? 'busy' : 'no-answer');
    }

    // ---- first contact: log it and ring ------------------------------------------
    const caller = await identify();
    if (callSid) {
      await admin.from('messages').insert({
        company: COMPANY,
        customer_id: caller.customerId,
        lead_id: caller.leadId,
        contact_id: caller.contactId,
        channel: 'call',
        direction: 'in',
        from_number: from,
        to_number: fromNumber,
        body: `Incoming call from ${caller.who}`,
        status: 'ringing',
        twilio_sid: callSid,
      });
    }

    // Ring the app only when phones can actually be reached (VoIP push).
    const appReady = Boolean(Deno.env.get('TWILIO_PUSH_CREDENTIAL_SID'));
    let identities: string[] = [];
    if (appReady) {
      const { data: admins } = await admin.from('employees').select('email').eq('company', COMPANY).in('role', ['owner', 'operator']).eq('is_test', false);
      const emails = ((admins as { email: string }[] | null) ?? []).map((a) => a.email.toLowerCase());
      if (emails.length > 0) {
        const { data: profiles } = await admin.from('staff_profiles').select('voice_identity').eq('company', COMPANY).in('email', emails).not('voice_identity', 'is', null);
        identities = ((profiles as { voice_identity: string }[] | null) ?? []).map((p) => p.voice_identity).filter(Boolean);
      }
    }
    if (identities.length === 0) return dialCell();

    const paramXml =
      `<Parameter name="displayName" value="${esc(caller.who)}"/>` +
      (from ? `<Parameter name="phone" value="${esc(from)}"/>` : '') +
      (caller.customerId ? `<Parameter name="customerId" value="${esc(caller.customerId)}"/>` : '') +
      (caller.leadId ? `<Parameter name="leadId" value="${esc(caller.leadId)}"/>` : '') +
      (caller.contactId ? `<Parameter name="contactId" value="${esc(caller.contactId)}"/>` : '');
    const clients = identities
      .map(
        (identity) =>
          `<Client statusCallback="${esc(statusUrl)}" statusCallbackEvent="completed" statusCallbackMethod="POST">` +
          `<Identity>${esc(identity)}</Identity>${paramXml}</Client>`,
      )
      .join('');
    return xml(
      `<Response>` +
        `<Dial timeout="${APP_RING_SECONDS}" answerOnBridge="true" action="${esc(`${self}?k=${k}&step=app`)}" method="POST">${clients}</Dial>` +
        `</Response>`,
    );
  } catch (e) {
    console.error('twilio-voice-inbound failed', e);
    return sayAndHangUp('Sorry, something went wrong taking your call. Please text us at this number.');
  }
});
