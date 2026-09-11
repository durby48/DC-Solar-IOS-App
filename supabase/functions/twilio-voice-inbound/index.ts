/**
 * twilio-voice-inbound — what happens when a CUSTOMER CALLS the DC Solar
 * number (2026-09-08). The number's "A call comes in" webhook points here
 * (docs/TWILIO_SETUP.md § 8); until then Twilio's demo answers, which is
 * what has been happening since the number was bought.
 *
 * WHO RINGS (v2, 2026-09-08). `voice_routes` maps the DIALED number to ONE
 * employee (`assigned_to`, an employees.email). The main number rings
 * Devon; a second number can ring Isaiah later with one row and no code.
 *
 * THE RING ORDER
 *   1. that person's app, as a real iPhone call (CallKit), if they have a
 *      voice identity and the push credential exists.
 *   2. that person's own cell (staff_profiles.cell_phone_e164, when
 *      voice_bridge_enabled), if the app did not answer or is not configured.
 *      Never the Twilio number itself — a loop is refused.
 *   3. a short spoken apology and a hang-up. No voicemail yet.
 * A number with no route skips to 3 and the missed-call push goes to the
 * admins, so an unrouted number gets noticed rather than guessed about.
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
    // The number that was dialed decides who rings. Twilio sends it on every
    // step of the same call, so no state has to be carried between steps.
    const dialed = toE164(form.get('To') ?? '') ?? fromNumber;
    const step = url.searchParams.get('step') ?? '';
    const k = encodeURIComponent(webhookSecret);
    const statusUrl = `${base}/twilio-status?k=${k}`;

    // --- who this number belongs to ----------------------------------------------
    interface Route {
      assignedTo: string;
      identity: string | null;
      cell: string | null;
    }
    const resolveRoute = async (): Promise<Route | null> => {
      const { data: routeRow } = await admin
        .from('voice_routes')
        .select('assigned_to')
        .eq('company', COMPANY)
        .eq('number_e164', dialed)
        .maybeSingle();
      const assignedTo = (routeRow as { assigned_to?: string } | null)?.assigned_to?.toLowerCase();
      if (!assignedTo) return null;
      const { data: profile } = await admin
        .from('staff_profiles')
        .select('voice_identity, cell_phone_e164, voice_bridge_enabled')
        .eq('company', COMPANY)
        .eq('email', assignedTo)
        .maybeSingle();
      const p = profile as { voice_identity: string | null; cell_phone_e164: string | null; voice_bridge_enabled: boolean } | null;
      const cell = p?.cell_phone_e164 && p.voice_bridge_enabled !== false ? p.cell_phone_e164 : null;
      // A cell that IS a Twilio number would ring this function again. Refuse.
      const safeCell = cell && cell !== dialed && cell !== fromNumber ? cell : null;
      return { assignedTo, identity: p?.voice_identity ?? null, cell: safeCell };
    };

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

    // --- the assigned person's cell, the fallback ------------------------------
    const dialCell = async (route: Route | null): Promise<Response> => {
      const cell = route?.cell ?? null;
      if (!cell) return finish(await identify(), 'no-answer', route);
      return xml(
        `<Response>` +
          `<Dial callerId="${esc(from ?? fromNumber)}" timeout="${CELL_RING_SECONDS}" answerOnBridge="true" action="${esc(`${self}?k=${k}&step=cell`)}" method="POST">` +
          `<Number statusCallback="${esc(statusUrl)}" statusCallbackEvent="completed" statusCallbackMethod="POST">${esc(cell)}</Number>` +
          `</Dial>` +
          `</Response>`,
      );
    };

    /**
     * The call is over without an answer: mark it, tell the person whose
     * number it is (the admins when the number is unrouted), apologise.
     */
    const finish = async (caller: Caller, status: string, route: Route | null): Promise<Response> => {
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
              ...(route ? { emails: [route.assignedTo] } : {}),
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
    // `answered` is the rare case where the action fires while the child leg
    // is still up; treating it as unanswered would dial the cell on top of a
    // live app call.
    const ANSWERED = new Set(['completed', 'answered']);
    if (step === 'app') {
      const outcome = form.get('DialCallStatus') ?? '';
      if (ANSWERED.has(outcome)) return xml('<Response/>');
      return dialCell(await resolveRoute());
    }

    // ---- step: the cell dial finished --------------------------------------------
    if (step === 'cell') {
      const outcome = form.get('DialCallStatus') ?? '';
      if (ANSWERED.has(outcome)) return xml('<Response/>');
      return finish(await identify(), outcome === 'busy' ? 'busy' : 'no-answer', await resolveRoute());
    }

    // ---- first contact: log it and ring ------------------------------------------
    const [caller, route] = await Promise.all([identify(), resolveRoute()]);
    if (callSid) {
      await admin.from('messages').insert({
        company: COMPANY,
        customer_id: caller.customerId,
        lead_id: caller.leadId,
        contact_id: caller.contactId,
        channel: 'call',
        direction: 'in',
        from_number: from,
        to_number: dialed,
        body: `Incoming call from ${caller.who}`,
        status: 'ringing',
        twilio_sid: callSid,
      });
    }

    // Ring the app only when phones can actually be reached (VoIP push) and
    // the number's person has a voice identity (they opened the app once).
    const appReady = Boolean(Deno.env.get('TWILIO_PUSH_CREDENTIAL_SID'));
    const identities: string[] = appReady && route?.identity ? [route.identity] : [];
    if (identities.length === 0) return dialCell(route);

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
