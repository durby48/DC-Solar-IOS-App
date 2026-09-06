/**
 * Communications data layer — the shared inbox on the DC Solar business number.
 *
 * WHAT THIS IS FOR
 *
 * Before this module the only way to reach a customer was `tel:` or `mailto:`
 * from somebody's personal phone. The reply landed on that phone, nobody else
 * could see it, and when that person was on a roof it sat unread. Everything
 * here reads and writes `public.messages`, which is ONE timeline per customer
 * holding every text and every bridge call, in both directions.
 *
 * HOUSE RULES FOLLOWED HERE
 *
 * - NOTHING THROWS. Reads return an empty collection or `null`; writes return
 *   `{ok:true, …}` or `{ok:false, message, code?}`. `messages` is admin-only on
 *   all four verbs, so a viewer's every query comes back empty rather than
 *   erroring — that is a legitimate state, not a failure, and no screen may
 *   crash on it.
 * - THE SERVER IS THE AUTHORITY ON WHETHER A SEND IS ALLOWED. `sendSms` does
 *   not pre-check opt-out or configuration; `twilio-send-sms` re-checks the
 *   caller's role, refuses opted-out customers, and returns 503
 *   `not_configured` until Devon finishes docs/TWILIO_SETUP.md. This module
 *   only translates those answers into sentences a person can act on.
 * - REALTIME IS NEVER THE SOURCE OF TRUTH. `useCommsRealtime` exists so an
 *   inbound text lands without a pull-to-refresh. Every caller keeps its
 *   `useFocusEffect` refetch: a socket that silently died must cost a stale
 *   screen for a few seconds, not a lost message.
 *
 * TWILIO WENT LIVE ON 2026-09-06 (A2P campaign verified, texts proven both
 * ways). The 503 `not_configured` path still exists and still matters: it is
 * what every screen shows if `comms_settings.sms_enabled` is ever switched
 * off again, and NOT_CONFIGURED_SMS / NOT_CONFIGURED_VOICE below are the one
 * honest sentence for that state rather than an edge-function stack trace.
 *
 * THE PHONE SECTION (2026-09-06) reads three more things from here: the
 * directory (`fetchDirectory`, one server-side union of customers, leads,
 * crew and suppliers), the call log (`fetchRecents`, folded like iOS), and
 * the third thread slot — `messages.contact_id`, for suppliers/vendors in
 * the new `contacts` table.
 *
 * PICTURES GO OUT AS STORAGE PATHS, NEVER URLS. `uploadMmsAttachment` puts
 * the compressed file in the private job-photos bucket under `mms/` and
 * hands back the path; `twilio-send-sms` signs it server-side. Rows keep the
 * paths in `media_urls`, and `fetchThread` signs them again for display —
 * one batched call per thread, the way lib/artwork.ts signs pipeline cards.
 */

import { useEffect, useRef } from 'react';

import { readFunctionError } from '@/lib/artwork';
import { COMPANY_PHONE } from '@/lib/company';
import { compressForUpload } from '@/lib/images';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

/** Where outbound MMS pictures live. No new bucket, no new storage policies. */
const MEDIA_BUCKET = 'job-photos';
/** Display signing for thread bubbles. The thread refetches on focus anyway. */
const MEDIA_DISPLAY_TTL = 3600;
/** Twilio's per-message ceiling. */
export const MMS_MAX_ATTACHMENTS = 10;
/** Twilio's per-picture ceiling is 5 MB; we compress well under it first. */
export const MMS_MAX_BYTES = 5 * 1024 * 1024;

/**
 * How much history one inbox pull walks. The thread list only needs the newest
 * message per customer plus unread counts, and grouping 500 rows on the phone
 * is cheaper than 60 round trips. Raise it when DC Solar outgrows it; a
 * server-side rollup is the real answer at that point.
 */
const THREAD_SCAN_LIMIT = 500;

/** One conversation's worth of history. */
const THREAD_LIMIT = 300;

export const NOT_CONFIGURED_SMS =
  "Texting isn't set up yet — see docs/TWILIO_SETUP.md";

export const NOT_CONFIGURED_VOICE =
  "Calling from the DC Solar number isn't set up yet — see docs/TWILIO_SETUP.md";

const MESSAGE_COLUMNS =
  'id, created_at, company, customer_id, lead_id, contact_id, job_id, channel, direction, from_number, ' +
  'to_number, body, status, twilio_sid, error_code, error, sent_by, num_segments, media_urls, ' +
  'duration_seconds, read_at, read_by';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MessageChannel = 'sms' | 'call';
export type MessageDirection = 'in' | 'out';

/**
 * One row of `public.messages`.
 *
 * `status` is deliberately a bare string. It carries Twilio's own vocabulary
 * (queued/sending/sent/delivered/undelivered/failed for texts,
 * queued/ringing/in-progress/completed/busy/no-answer/canceled for calls,
 * plus 'received' for inbound) and Twilio adds to it. The database has no
 * CHECK constraint on it for the same reason; a union type here would be a
 * lie the compiler enforces.
 */
export interface CommsMessage {
  id: string;
  created_at: string;
  company: string;
  customer_id: string | null;
  lead_id: string | null;
  /** A supplier / vendor from `contacts` — the third thread slot (2026-09-06). */
  contact_id: string | null;
  job_id: string | null;
  channel: MessageChannel;
  direction: MessageDirection;
  from_number: string | null;
  to_number: string;
  body: string | null;
  status: string;
  twilio_sid: string | null;
  error_code: string | null;
  error: string | null;
  sent_by: string | null;
  num_segments: number | null;
  /**
   * MMS attachments, ready to display. `media_urls` is jsonb in the database
   * and holds Twilio's own URLs for inbound pictures and STORAGE PATHS for
   * outbound ones; `fetchThread` signs the paths so this is always an array
   * of loadable URLs by the time a screen sees it.
   */
  media_urls: string[];
  duration_seconds: number | null;
  read_at: string | null;
  read_by: string | null;
}

/** One row in the inbox: everything said to and by one person. */
export interface CommsThread {
  /**
   * Stable list key: the customer id, `contact:<id>` for a supplier, or
   * `num:+18165550123` for a stranger.
   */
  key: string;
  customerId: string | null;
  /** Set when the far end is a supplier / vendor rather than a customer. */
  contactId: string | null;
  /** The customer's name, or the E.164 number when nobody has claimed it. */
  displayName: string;
  /** The far end of the conversation, E.164 where we could work it out. */
  phone: string | null;
  /** True when no customer record matches — the inbox offers "Add as customer". */
  unknown: boolean;
  lastMessage: CommsMessage;
  lastAt: string;
  preview: string;
  unread: number;
  /** They replied STOP. We may still call them; we may not text them. */
  optedOut: boolean;
}

export interface CommsSettings {
  company: string;
  /** The purchased Twilio number, E.164. Null until Devon buys one. */
  fromNumber: string | null;
  smsEnabled: boolean;
  voiceEnabled: boolean;
  recordCalls: boolean;
  /** 'HH:MM:SS' local to America/Chicago. */
  businessHoursStart: string;
  businessHoursEnd: string;
  afterHoursAutoreply: string | null;
  reviewLink: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface MessageTemplate {
  id: string;
  company: string;
  key: string;
  title: string;
  body: string;
  channel: string;
  active: boolean;
  sort: number;
}

export interface StaffProfile {
  company: string;
  email: string;
  cellPhone: string | null;
  /** GENERATED in the database: +1XXXXXXXXXX or null. Never written by us. */
  cellPhoneE164: string | null;
  voiceBridgeEnabled: boolean;
  updatedAt: string | null;
}

export type CommsResult = { ok: true } | { ok: false; message: string; code?: string };

export type SendSmsResult =
  | { ok: true; messageId: string | null; twilioSid: string | null; status: string }
  | { ok: false; message: string; code?: string };

export type CallResult =
  | { ok: true; messageId: string | null; callSid: string | null; warning?: string }
  | { ok: false; message: string; code?: string };

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Signed-in email, lowercased, or null. Never throws. */
async function currentEmail(): Promise<string | null> {
  try {
    const { data } = await supabase.auth.getSession();
    const email = data.session?.user?.email;
    return email ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * `media_urls` is jsonb, so it arrives as whatever twilio-inbound put there:
 * an array of strings, or null. Anything else is somebody else's bug and
 * becomes an empty array rather than a render crash.
 */
function toMediaUrls(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
}

function toMessage(row: Record<string, unknown>): CommsMessage {
  return {
    id: String(row.id),
    created_at: (row.created_at as string) ?? new Date().toISOString(),
    company: (row.company as string) ?? COMPANY,
    customer_id: (row.customer_id as string | null) ?? null,
    lead_id: (row.lead_id as string | null) ?? null,
    contact_id: (row.contact_id as string | null) ?? null,
    job_id: (row.job_id as string | null) ?? null,
    channel: (row.channel as MessageChannel) ?? 'sms',
    direction: (row.direction as MessageDirection) ?? 'out',
    from_number: (row.from_number as string | null) ?? null,
    to_number: (row.to_number as string) ?? '',
    body: (row.body as string | null) ?? null,
    status: (row.status as string) ?? 'queued',
    twilio_sid: (row.twilio_sid as string | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
    error: (row.error as string | null) ?? null,
    sent_by: (row.sent_by as string | null) ?? null,
    num_segments: row.num_segments != null ? Number(row.num_segments) : null,
    media_urls: toMediaUrls(row.media_urls),
    duration_seconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    read_at: (row.read_at as string | null) ?? null,
    read_by: (row.read_by as string | null) ?? null,
  };
}

/** The far end of a conversation: who we heard from, or who we sent to. */
function counterpartNumber(message: CommsMessage): string | null {
  const raw = message.direction === 'in' ? message.from_number : message.to_number;
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * "+18165550123" → "(816) 555-0123". Anything that is not a US 11-digit E.164
 * comes back untouched — a mangled pretty-printer is worse than raw digits.
 */
export function formatPhone(e164: string | null | undefined): string {
  if (!e164) return '';
  const digits = e164.replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return e164;
}

/**
 * Pull the JSON body out of a failed `functions.invoke()` without consuming it.
 *
 * supabase-js flattens every non-2xx into "Edge Function returned a non-2xx
 * status code" and hides the real body on `error.context`. Without this, a 503
 * `not_configured`, a 400 `opted_out` and a 502 Twilio rejection are the same
 * sentence — which is how you end up telling Devon to check his Twilio account
 * when the customer simply replied STOP. Mirrors
 * `lib/documents.ts::readFunctionPayload`.
 */
async function readFunctionPayload(error: unknown): Promise<Record<string, unknown> | null> {
  const context = (error as { context?: unknown })?.context;
  if (!context || typeof context !== 'object') return null;
  const response = context as Response;
  try {
    if (typeof response.clone === 'function') {
      return (await response.clone().json()) as Record<string, unknown>;
    }
  } catch {
    // not JSON — the caller falls back to readFunctionError()
  }
  return null;
}

/**
 * One place that decides what a failed comms call SAYS.
 *
 * `not_configured` is the answer to expect for months, so it never shows the
 * edge function's paragraph about environment variables — the crew cannot act
 * on that. Every other code carries real, specific information (which number
 * is wrong, who opted out, what Twilio objected to) and is passed through
 * verbatim.
 */
function commsFailure(
  code: string | undefined,
  serverMessage: string | null,
  kind: 'sms' | 'voice',
): { ok: false; message: string; code?: string } {
  if (code === 'not_configured') {
    return {
      ok: false,
      code,
      message: kind === 'sms' ? NOT_CONFIGURED_SMS : NOT_CONFIGURED_VOICE,
    };
  }
  if (code === 'no_staff_number') {
    return {
      ok: false,
      code,
      message:
        serverMessage ?? 'Add your cell number in Messages settings — that is the phone we ring first.',
    };
  }
  if (code === 'forbidden' || code === 'unauthorized') {
    return {
      ok: false,
      code,
      message: serverMessage ?? 'Only owners and operators can text or call from the DC Solar number.',
    };
  }
  return {
    ok: false,
    code,
    message:
      serverMessage ??
      (kind === 'sms' ? 'The text could not be sent.' : 'The call could not be placed.'),
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * The single `comms_settings` row. Member-readable, so the whole crew can see
 * the business number and the business hours. Null when the migration has not
 * been applied, when the read is denied, or when signed out — every caller
 * treats null as "not configured", which is the safe reading.
 */
export async function fetchCommsSettings(): Promise<CommsSettings | null> {
  try {
    const { data, error } = await supabase
      .from('comms_settings')
      .select(
        'company, from_number, sms_enabled, voice_enabled, record_calls, business_hours_start, ' +
          'business_hours_end, after_hours_autoreply, review_link, updated_at, updated_by',
      )
      .eq('company', COMPANY)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as Record<string, unknown>;
    return {
      company: (row.company as string) ?? COMPANY,
      fromNumber: (row.from_number as string | null) ?? null,
      smsEnabled: Boolean(row.sms_enabled),
      voiceEnabled: Boolean(row.voice_enabled),
      recordCalls: Boolean(row.record_calls),
      businessHoursStart: (row.business_hours_start as string) ?? '07:00:00',
      businessHoursEnd: (row.business_hours_end as string) ?? '18:00:00',
      afterHoursAutoreply: (row.after_hours_autoreply as string | null) ?? null,
      reviewLink: (row.review_link as string | null) ?? null,
      updatedAt: (row.updated_at as string | null) ?? null,
      updatedBy: (row.updated_by as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

export interface CommsSettingsInput {
  fromNumber?: string | null;
  smsEnabled?: boolean;
  voiceEnabled?: boolean;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  afterHoursAutoreply?: string | null;
  reviewLink?: string | null;
}

/**
 * Admin: change the comms settings.
 *
 * There is no INSERT policy on `comms_settings` on purpose — one seeded row is
 * the only row a client can ever see — so this is an UPDATE, and an update
 * that matches nothing is what an RLS denial looks like from here. That is why
 * the row count is checked rather than only the error.
 */
export async function saveCommsSettings(patch: CommsSettingsInput): Promise<CommsResult> {
  try {
    const email = await currentEmail();
    const update: Record<string, unknown> = { updated_by: email };
    if (patch.fromNumber !== undefined) update.from_number = patch.fromNumber;
    if (patch.smsEnabled !== undefined) update.sms_enabled = patch.smsEnabled;
    if (patch.voiceEnabled !== undefined) update.voice_enabled = patch.voiceEnabled;
    if (patch.businessHoursStart !== undefined) {
      update.business_hours_start = patch.businessHoursStart;
    }
    if (patch.businessHoursEnd !== undefined) update.business_hours_end = patch.businessHoursEnd;
    if (patch.afterHoursAutoreply !== undefined) {
      update.after_hours_autoreply = patch.afterHoursAutoreply;
    }
    if (patch.reviewLink !== undefined) update.review_link = patch.reviewLink;

    const { data, error } = await supabase
      .from('comms_settings')
      .update(update)
      .eq('company', COMPANY)
      .select('company');
    if (error) {
      return { ok: false, message: error.message || 'Could not save the messaging settings.' };
    }
    if (!data || data.length === 0) {
      return {
        ok: false,
        message: 'Only owners and operators can change the messaging settings.',
      };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not save the messaging settings.',
    };
  }
}

// ---------------------------------------------------------------------------
// My staff profile (the phone Twilio rings first on a bridge call)
// ---------------------------------------------------------------------------

/**
 * My own `staff_profiles` row, or null when I have never saved one.
 *
 * The table is deliberately NOT a column on `employees`: that table's security
 * rests on having zero write policies, and a writable cell-phone column would
 * mean adding one. Do not "simplify" this back onto `employees`.
 */
export async function fetchMyStaffProfile(): Promise<StaffProfile | null> {
  try {
    const email = await currentEmail();
    if (!email) return null;
    const { data, error } = await supabase
      .from('staff_profiles')
      .select('company, email, cell_phone, cell_phone_e164, voice_bridge_enabled, updated_at')
      .eq('company', COMPANY)
      .eq('email', email)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as unknown as Record<string, unknown>;
    return {
      company: (row.company as string) ?? COMPANY,
      email: (row.email as string) ?? email,
      cellPhone: (row.cell_phone as string | null) ?? null,
      cellPhoneE164: (row.cell_phone_e164 as string | null) ?? null,
      voiceBridgeEnabled: row.voice_bridge_enabled !== false,
      updatedAt: (row.updated_at as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Save my cell number. Upserts my own row — the database trigger lowercases
 * the email, which is what keeps the (company, email) primary key from
 * collecting two rows for the same person.
 *
 * `cell_phone_e164` is GENERATED, so a number that cannot be parsed as US
 * saves fine and simply never dials; the settings screen says so rather than
 * refusing the save, because a half-typed number is a normal thing to have on
 * screen.
 */
export async function saveMyCellPhone(phone: string | null): Promise<CommsResult> {
  try {
    const email = await currentEmail();
    if (!email) return { ok: false, message: 'Sign in first.' };
    const trimmed = phone?.trim() ?? '';
    const { error } = await supabase
      .from('staff_profiles')
      .upsert(
        { company: COMPANY, email, cell_phone: trimmed.length > 0 ? trimmed : null },
        { onConflict: 'company,email' },
      );
    if (error) return { ok: false, message: error.message || 'Could not save your cell number.' };
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not save your cell number.',
    };
  }
}

/** Turn my own bridge calling on or off without touching the number. */
export async function setMyVoiceBridge(enabled: boolean): Promise<CommsResult> {
  try {
    const email = await currentEmail();
    if (!email) return { ok: false, message: 'Sign in first.' };
    const { error } = await supabase
      .from('staff_profiles')
      .upsert(
        { company: COMPANY, email, voice_bridge_enabled: enabled },
        { onConflict: 'company,email' },
      );
    if (error) return { ok: false, message: error.message || 'Could not save that.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save that.' };
  }
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

/**
 * The inbox: one row per conversation, newest first.
 *
 * TWO QUERIES, NEVER N+1. One pull of recent `messages`, grouped on the phone,
 * then a single `in(...)` for the customer names. The CRM list's avatar
 * batching exists for the same reason; a per-thread name lookup would be 40
 * round trips on a screen that has to feel instant.
 *
 * An inbound text from a number nobody has saved still gets a thread — keyed
 * on the number, flagged `unknown`, and offered an "Add as customer" action.
 * Losing it because it has no `customer_id` would be the same failure the
 * whole feature exists to fix.
 *
 * Returns an empty array for viewers (RLS gives them zero rows), for a
 * database without the comms migration, and when signed out.
 */
export async function fetchThreads(): Promise<CommsThread[]> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('company', COMPANY)
      .order('created_at', { ascending: false })
      .limit(THREAD_SCAN_LIMIT);
    if (error || !data) return [];

    const messages = (data as unknown as Record<string, unknown>[]).map(toMessage);

    interface Draft {
      key: string;
      customerId: string | null;
      contactId: string | null;
      phone: string | null;
      last: CommsMessage;
      unread: number;
    }
    const drafts = new Map<string, Draft>();

    for (const message of messages) {
      const phone = counterpartNumber(message);
      const key = message.customer_id
        ? message.customer_id
        : message.contact_id
          ? `contact:${message.contact_id}`
          : phone
            ? `num:${phone}`
            : 'num:unknown';
      const existing = drafts.get(key);
      if (existing) {
        // The scan is newest-first, so the first row wins as `last`.
        if (message.direction === 'in' && !message.read_at) existing.unread += 1;
        if (!existing.phone && phone) existing.phone = phone;
      } else {
        drafts.set(key, {
          key,
          customerId: message.customer_id,
          contactId: message.customer_id ? null : message.contact_id,
          phone,
          last: message,
          unread: message.direction === 'in' && !message.read_at ? 1 : 0,
        });
      }
    }

    // One name lookup for every customer that appears in the scan, and one
    // for every supplier. Still two queries, never N+1.
    const customerIds = [...drafts.values()]
      .map((d) => d.customerId)
      .filter((id): id is string => typeof id === 'string');
    const contactIds = [...drafts.values()]
      .map((d) => d.contactId)
      .filter((id): id is string => typeof id === 'string');
    const names = new Map<string, { name: string; optedOut: boolean; phone: string | null }>();
    const contactNames = new Map<string, { name: string; phone: string | null }>();
    await Promise.all([
      (async () => {
        if (customerIds.length === 0) return;
        const { data: rows } = await supabase
          .from('customers')
          .select('id, name, phone_e164, sms_opt_out_at')
          .in('id', customerIds);
        for (const row of (rows ?? []) as Record<string, unknown>[]) {
          names.set(String(row.id), {
            name: (row.name as string) ?? 'Customer',
            optedOut: row.sms_opt_out_at != null,
            phone: (row.phone_e164 as string | null) ?? null,
          });
        }
      })(),
      (async () => {
        if (contactIds.length === 0) return;
        const { data: rows } = await supabase
          .from('contacts')
          .select('id, name, org, phone_e164')
          .in('id', contactIds);
        for (const row of (rows ?? []) as Record<string, unknown>[]) {
          const org = (row.org as string | null) ?? null;
          const name = (row.name as string) ?? 'Contact';
          contactNames.set(String(row.id), {
            name: org && org !== name ? `${name} · ${org}` : name,
            phone: (row.phone_e164 as string | null) ?? null,
          });
        }
      })(),
    ]);

    const threads: CommsThread[] = [...drafts.values()].map((draft) => {
      const record = draft.customerId ? names.get(draft.customerId) : undefined;
      const contact = draft.contactId ? contactNames.get(draft.contactId) : undefined;
      const phone = draft.phone ?? record?.phone ?? contact?.phone ?? null;
      return {
        key: draft.key,
        customerId: draft.customerId,
        contactId: contact ? draft.contactId : null,
        displayName:
          record?.name ?? contact?.name ?? (phone ? formatPhone(phone) : 'Unknown number'),
        phone,
        // A row can carry a customer_id whose customer has since been merged
        // away; if we could not read a name it behaves like a stranger.
        unknown: !record && !contact,
        lastMessage: draft.last,
        lastAt: draft.last.created_at,
        preview: previewFor(draft.last),
        unread: draft.unread,
        optedOut: record?.optedOut ?? false,
      };
    });

    threads.sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
    return threads;
  } catch {
    return [];
  }
}

/** The one-line summary under a thread's name. */
function previewFor(message: CommsMessage): string {
  if (message.channel === 'call') {
    if (message.status === 'failed' || message.status === 'busy' || message.status === 'no-answer') {
      return 'Call did not connect';
    }
    return message.duration_seconds ? `Call · ${formatDuration(message.duration_seconds)}` : 'Call';
  }
  const body = (message.body ?? '').replace(/\s+/g, ' ').trim();
  if (body.length > 0) return message.direction === 'out' ? `You: ${body}` : body;
  if (message.media_urls.length > 0) return message.direction === 'out' ? 'You: (photo)' : '(photo)';
  return '';
}

/** 252 → "4m 12s". Call pills read better than a raw second count. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) return `${rest}s`;
  return `${minutes}m ${rest}s`;
}

/**
 * One conversation, oldest first — the order a chat reads in.
 *
 * `customerId` may be a customer id, a contact id (`byContact`), or, for a
 * stranger, their E.164 number (`byPhone`). The unknown-number case matches
 * on both ends of the row because an outbound text to a stranger stores them
 * in `to_number` while their reply stores them in `from_number`.
 *
 * Outbound pictures come back as storage paths and are signed here, in one
 * batched call, so every screen that renders a thread gets loadable URLs.
 */
export async function fetchThread(
  customerId: string,
  options?: { byPhone?: boolean; byContact?: boolean },
): Promise<CommsMessage[]> {
  try {
    let query = supabase.from('messages').select(MESSAGE_COLUMNS).eq('company', COMPANY);
    if (options?.byPhone) {
      query = query
        .is('customer_id', null)
        .is('contact_id', null)
        .or(`from_number.eq.${customerId},to_number.eq.${customerId}`);
    } else if (options?.byContact) {
      query = query.eq('contact_id', customerId);
    } else {
      query = query.eq('customer_id', customerId);
    }
    const { data, error } = await query
      .order('created_at', { ascending: true })
      .limit(THREAD_LIMIT);
    if (error || !data) return [];
    return signMediaPaths((data as unknown as Record<string, unknown>[]).map(toMessage));
  } catch {
    return [];
  }
}

/**
 * Storage paths in `media_urls` → signed display URLs.
 *
 * Inbound MMS carries Twilio's own https URLs and passes through untouched;
 * outbound rows hold `mms/…` paths in the job-photos bucket, because a signed
 * URL expires and a path does not. ONE `createSignedUrls` call for the whole
 * thread — signing per bubble is a storage request per picture on a screen
 * that has to feel like a chat. A path that fails to sign is dropped rather
 * than rendered as a broken image.
 */
export async function signMediaPaths(messages: CommsMessage[]): Promise<CommsMessage[]> {
  const paths = new Set<string>();
  for (const message of messages) {
    for (const entry of message.media_urls) {
      if (!/^https?:\/\//i.test(entry)) paths.add(entry);
    }
  }
  if (paths.size === 0) return messages;

  const list = [...paths];
  const signed = new Map<string, string>();
  try {
    const { data } = await supabase.storage
      .from(MEDIA_BUCKET)
      .createSignedUrls(list, MEDIA_DISPLAY_TTL);
    (data ?? []).forEach((entry, index) => {
      const url = (entry as { signedUrl?: string | null }).signedUrl;
      const path = list[index];
      if (url && path) signed.set(path, url);
    });
  } catch {
    // Everything below falls back to "no picture" for the unsigned paths.
  }

  return messages.map((message) => {
    if (!message.media_urls.some((entry) => paths.has(entry))) return message;
    return {
      ...message,
      media_urls: message.media_urls
        .map((entry) => (paths.has(entry) ? (signed.get(entry) ?? null) : entry))
        .filter((entry): entry is string => typeof entry === 'string'),
    };
  });
}

/**
 * Mark every unread inbound message in one thread as read, by me.
 *
 * Pass a customer id, or `null` plus the stranger's number for an unclaimed
 * thread. Silent about failures on purpose: this fires when a screen opens,
 * and a failed read-stamp must never interrupt reading the conversation.
 */
export async function markThreadRead(
  customerId: string | null,
  phone?: string | null,
): Promise<CommsResult> {
  try {
    const email = await currentEmail();
    if (!email) return { ok: false, message: 'Sign in first.' };
    let query = supabase
      .from('messages')
      .update({ read_at: new Date().toISOString(), read_by: email })
      .eq('company', COMPANY)
      .eq('direction', 'in')
      .is('read_at', null);
    if (customerId) {
      query = query.eq('customer_id', customerId);
    } else if (phone) {
      query = query.is('customer_id', null).eq('from_number', phone);
    } else {
      return { ok: false, message: 'Nothing to mark read.' };
    }
    const { error } = await query;
    if (error) return { ok: false, message: error.message || 'Could not mark the thread read.' };
    return { ok: true };
  } catch {
    return { ok: false, message: 'Could not mark the thread read.' };
  }
}

/**
 * How many inbound messages are unread across every thread — the badge number.
 * Zero on any problem, which is also what a viewer correctly sees.
 */
export async function fetchUnreadCount(): Promise<number> {
  try {
    const { count, error } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('company', COMPANY)
      .eq('direction', 'in')
      .is('read_at', null);
    if (error || count == null) return 0;
    return count;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendSmsInput {
  customerId?: string;
  leadId?: string;
  /** A supplier / vendor from `contacts`. */
  contactId?: string;
  /** A bare number, for a stranger or a test to yourself. */
  to?: string;
  /** May be empty when `mediaPaths` is not. */
  body: string;
  jobId?: string;
  templateKey?: string;
  /**
   * Storage PATHS from `uploadMmsAttachment` — never URLs. The server signs
   * them; a client that could pass a URL could make the company number send
   * anything on the internet to a customer.
   */
  mediaPaths?: string[];
}

/**
 * Send one text from the DC Solar number.
 *
 * Everything that decides whether this is allowed lives on the server:
 * `twilio-send-sms` re-checks the caller's role, refuses a customer who
 * replied STOP no matter what the client asks for, and writes the `messages`
 * row BEFORE it calls Twilio so a timeout still leaves a record. This function
 * does not second-guess any of it — it sends, and translates the answer.
 */
export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  try {
    const { data, error } = await supabase.functions.invoke('twilio-send-sms', {
      body: {
        customerId: input.customerId,
        leadId: input.leadId,
        contactId: input.contactId,
        to: input.to,
        body: input.body,
        jobId: input.jobId,
        templateKey: input.templateKey,
        mediaPaths: input.mediaPaths && input.mediaPaths.length > 0 ? input.mediaPaths : undefined,
      },
    });
    if (error) {
      const payload = await readFunctionPayload(error);
      const code = typeof payload?.code === 'string' ? payload.code : undefined;
      const serverMessage =
        typeof payload?.error === 'string' && payload.error.length > 0
          ? payload.error
          : await readFunctionError(error);
      return commsFailure(code, serverMessage ?? error.message ?? null, 'sms');
    }
    const result = data as {
      ok?: boolean;
      code?: string;
      error?: string;
      messageId?: string;
      twilioSid?: string | null;
      status?: string;
    } | null;
    if (!result?.ok) {
      return commsFailure(result?.code, result?.error ?? null, 'sms');
    }
    return {
      ok: true,
      messageId: result.messageId ?? null,
      twilioSid: result.twilioSid ?? null,
      status: result.status ?? 'queued',
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The text could not be sent.' };
  }
}

export interface PlaceCallInput {
  customerId?: string;
  /** A supplier / vendor from `contacts`. */
  contactId?: string;
  to?: string;
  jobId?: string;
}

/**
 * Place a bridge call: Twilio rings MY cell first, then dials the customer
 * with the business number as caller ID and joins the two.
 *
 * It reads backwards the first time — the phone that rings is yours — so every
 * caller of this function should say "Ringing your cell…" while it is in
 * flight, or the first person to try it will think it did nothing.
 */
export async function placeBridgeCall(input: PlaceCallInput): Promise<CallResult> {
  try {
    const { data, error } = await supabase.functions.invoke('twilio-call', {
      body: {
        customerId: input.customerId,
        contactId: input.contactId,
        to: input.to,
        jobId: input.jobId,
      },
    });
    if (error) {
      const payload = await readFunctionPayload(error);
      const code = typeof payload?.code === 'string' ? payload.code : undefined;
      const serverMessage =
        typeof payload?.error === 'string' && payload.error.length > 0
          ? payload.error
          : await readFunctionError(error);
      return commsFailure(code, serverMessage ?? error.message ?? null, 'voice');
    }
    const result = data as {
      ok?: boolean;
      code?: string;
      error?: string;
      messageId?: string | null;
      callSid?: string | null;
      warning?: string;
    } | null;
    if (!result?.ok) {
      return commsFailure(result?.code, result?.error ?? null, 'voice');
    }
    return {
      ok: true,
      messageId: result.messageId ?? null,
      callSid: result.callSid ?? null,
      warning: result.warning,
    };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'The call could not be placed.' };
  }
}

// ---------------------------------------------------------------------------
// Pictures (outbound MMS)
// ---------------------------------------------------------------------------

export type MmsUploadResult =
  | { ok: true; path: string; bytes: number }
  | { ok: false; message: string };

/**
 * Put one picked image where `twilio-send-sms` can sign it, and hand back
 * the storage PATH to pass as `mediaPaths`.
 *
 * Compressed first with the same `compressForUpload` every other upload in
 * the app uses — a 6 MB camera JPEG is over Twilio's per-picture limit and
 * would be refused at send time, after the customer's thread already showed
 * it as sending. Lives under `mms/` in the private job-photos bucket so no
 * new bucket and no new storage policy is needed; the `mms/` prefix is also
 * exactly what the edge function will accept and nothing else.
 */
export async function uploadMmsAttachment(input: {
  uri: string;
  contentType?: string | null;
}): Promise<MmsUploadResult> {
  try {
    const compressed = await compressForUpload(input.uri);
    const response = await fetch(compressed.uri);
    const body = await response.arrayBuffer();
    if (body.byteLength > MMS_MAX_BYTES) {
      return {
        ok: false,
        message: `That picture is ${(body.byteLength / (1024 * 1024)).toFixed(1)} MB; texts can carry up to 5 MB each.`,
      };
    }
    // Always JPEG after compression; only when compression was skipped does
    // the picker's own type survive, and it still has to be an image.
    const contentType = compressed.compressed
      ? 'image/jpeg'
      : (input.contentType ?? 'image/jpeg');
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/gif' ? 'gif' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const stamp = new Date().toISOString().slice(0, 7).replace('-', '/');
    const id =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const path = `mms/${stamp}/${id}.${ext}`;

    const { error } = await supabase.storage
      .from(MEDIA_BUCKET)
      .upload(path, body, { contentType, upsert: false });
    if (error) return { ok: false, message: error.message || 'Could not upload the picture.' };
    return { ok: true, path, bytes: body.byteLength };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not upload the picture.' };
  }
}

// ---------------------------------------------------------------------------
// Directory (Phone → Contacts, and the keypad's live match)
// ---------------------------------------------------------------------------

export type DirectorySource = 'customer' | 'lead' | 'crew' | 'contact';

/** One row of `phone_directory()`. */
export interface DirectoryEntry {
  source: DirectorySource;
  id: string;
  displayName: string;
  /** Address for a customer, status for a lead, role for crew, org for a contact. */
  subtitle: string | null;
  /** Null when the record has no usable US number — shown greyed, not hidden. */
  phoneE164: string | null;
  sortKey: string;
  archived: boolean;
}

/**
 * Everybody the Phone section can dial, A–Z, de-duplicated by handset.
 *
 * One SECURITY DEFINER function rather than four queries: the sort and the
 * de-dup happen once, server-side, and the function re-checks
 * `is_company_admin()` itself — so a crew member's cell number never
 * reaches a non-admin client. Empty for viewers, for the signed-out, and
 * for a database without the migration; every caller treats empty as "no
 * directory", which is honest in all three cases.
 */
export async function fetchDirectory(): Promise<DirectoryEntry[]> {
  try {
    const { data, error } = await supabase.rpc('phone_directory');
    if (error || !data) return [];
    return (data as Record<string, unknown>[])
      .map((row) => ({
        source: (row.source as DirectorySource) ?? 'customer',
        id: String(row.id ?? ''),
        displayName: (row.display_name as string | null)?.trim() || 'Unnamed',
        subtitle: (row.subtitle as string | null) ?? null,
        phoneE164: (row.phone_e164 as string | null) ?? null,
        sortKey: (row.sort_key as string | null) ?? '',
        archived: row.archived === true,
      }))
      .filter((entry) => entry.id.length > 0);
  } catch {
    return [];
  }
}

/**
 * Who a partly-typed number already is, for the keypad.
 *
 * Suffix match on digits once there are enough of them to mean something:
 * typing 7446473 finds +18167446473, and so does typing the whole thing with
 * or without the leading 1. Fewer than four digits matches nobody — every
 * 816 number in Kansas City would light up otherwise.
 */
export function matchDirectory(
  entries: DirectoryEntry[],
  typed: string,
  limit = 3,
): DirectoryEntry[] {
  const digits = typed.replace(/[^0-9]/g, '');
  if (digits.length < 4) return [];
  const needle = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const out: DirectoryEntry[] = [];
  for (const entry of entries) {
    if (!entry.phoneE164 || entry.archived) continue;
    const have = entry.phoneE164.replace(/[^0-9]/g, '');
    const local = have.length === 11 && have.startsWith('1') ? have.slice(1) : have;
    if (local.endsWith(needle) || local === needle) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

export interface ContactInput {
  name: string;
  org?: string | null;
  phone?: string | null;
  email?: string | null;
  /** supplier | vendor | inspector | other. Free text server-side. */
  kind?: string;
  notes?: string | null;
}

/**
 * Admin: add a supplier / vendor. Phase 1 built the table; only Devon knows
 * what belongs in it, so this is how it gets filled from the phone.
 */
export async function createContact(input: ContactInput): Promise<CommsResult> {
  try {
    const name = input.name.trim();
    if (!name) return { ok: false, message: 'Give the contact a name.' };
    const email = await currentEmail();
    const { error } = await supabase.from('contacts').insert({
      company: COMPANY,
      kind: (input.kind ?? 'supplier').trim().toLowerCase() || 'supplier',
      name,
      org: input.org?.trim() || null,
      phone: input.phone?.trim() || null,
      email: input.email?.trim() || null,
      notes: input.notes?.trim() || null,
      created_by: email,
    });
    if (error) {
      return {
        ok: false,
        message:
          error.code === '42501' || /row-level security|policy/i.test(error.message ?? '')
            ? 'Only owners and operators can add contacts.'
            : error.message || 'Could not save the contact.',
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the contact.' };
  }
}

/** One supplier / vendor, for the thread header. Null when missing or unreadable. */
export async function fetchContactById(
  id: string,
): Promise<{ id: string; name: string; org: string | null; phoneE164: string | null } | null> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, name, org, phone_e164')
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as Record<string, unknown>;
    return {
      id: String(row.id),
      name: (row.name as string) ?? 'Contact',
      org: (row.org as string | null) ?? null,
      phoneE164: (row.phone_e164 as string | null) ?? null,
    };
  } catch {
    return null;
  }
}

/** Admin: hide a supplier from the directory without losing their thread. */
export async function archiveContact(id: string): Promise<CommsResult> {
  try {
    const { data, error } = await supabase
      .from('contacts')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .select('id');
    if (error) return { ok: false, message: error.message || 'Could not archive the contact.' };
    if (!data || data.length === 0) {
      return { ok: false, message: 'Only owners and operators can archive contacts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not archive the contact.' };
  }
}

// ---------------------------------------------------------------------------
// Recents (Phone → Recents)
// ---------------------------------------------------------------------------

/** One row of the call log: one call, or a run of calls to the same party. */
export interface RecentCall {
  /** The most recent `messages` row in the run. */
  id: string;
  customerId: string | null;
  contactId: string | null;
  /** The far end, E.164 where we know it. */
  phone: string | null;
  /** Name when the row is filed under someone, else the formatted number. */
  displayName: string;
  direction: MessageDirection;
  status: string;
  /**
   * Did not connect. Until in-app calling ships there are no inbound calls
   * at all, so this is an OUTBOUND bridge call that ended failed / busy /
   * no-answer / canceled — the Recents screen says so on the segment.
   */
  missed: boolean;
  durationSeconds: number | null;
  at: string;
  /** How many consecutive calls to the same party this row stands for. */
  count: number;
  sentBy: string | null;
}

const CALL_MISSED = new Set(['failed', 'busy', 'no-answer', 'canceled']);

/**
 * The call log, newest first, folded the way iOS folds it: consecutive calls
 * to the same person collapse into one row with a count. No new tables —
 * every row is a `messages` row with `channel = 'call'` that twilio-call
 * already writes.
 */
export async function fetchRecents(limit = 300): Promise<RecentCall[]> {
  try {
    const { data, error } = await supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('company', COMPANY)
      .eq('channel', 'call')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    const calls = (data as unknown as Record<string, unknown>[]).map(toMessage);
    if (calls.length === 0) return [];

    const customerIds = new Set<string>();
    const contactIds = new Set<string>();
    for (const call of calls) {
      if (call.customer_id) customerIds.add(call.customer_id);
      else if (call.contact_id) contactIds.add(call.contact_id);
    }
    const customerNames = new Map<string, string>();
    const contactNames = new Map<string, string>();
    await Promise.all([
      (async () => {
        if (customerIds.size === 0) return;
        const { data: rows } = await supabase
          .from('customers')
          .select('id, name')
          .in('id', [...customerIds]);
        for (const row of (rows ?? []) as Record<string, unknown>[]) {
          customerNames.set(String(row.id), (row.name as string) ?? 'Customer');
        }
      })(),
      (async () => {
        if (contactIds.size === 0) return;
        const { data: rows } = await supabase
          .from('contacts')
          .select('id, name')
          .in('id', [...contactIds]);
        for (const row of (rows ?? []) as Record<string, unknown>[]) {
          contactNames.set(String(row.id), (row.name as string) ?? 'Contact');
        }
      })(),
    ]);

    const rows: RecentCall[] = [];
    for (const call of calls) {
      const phone = counterpartNumber(call);
      const partyKey = call.customer_id ?? call.contact_id ?? phone ?? call.id;
      const previous = rows[rows.length - 1];
      const missed = CALL_MISSED.has(call.status);
      // Fold onto the row above only when it is the same party AND the same
      // outcome — three missed calls read as "missed ×3", but a missed call
      // followed by one that connected are two different facts.
      if (
        previous &&
        (previous.customerId ?? previous.contactId ?? previous.phone ?? previous.id) === partyKey &&
        previous.missed === missed
      ) {
        previous.count += 1;
        continue;
      }
      rows.push({
        id: call.id,
        customerId: call.customer_id,
        contactId: call.customer_id ? null : call.contact_id,
        phone,
        displayName:
          (call.customer_id ? customerNames.get(call.customer_id) : undefined) ??
          (call.contact_id ? contactNames.get(call.contact_id) : undefined) ??
          (phone ? formatPhone(phone) : 'Unknown number'),
        direction: call.direction,
        status: call.status,
        missed,
        durationSeconds: call.duration_seconds,
        at: call.created_at,
        count: 1,
        sentBy: call.sent_by,
      });
    }
    return rows;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * The saved texts, in display order. Member-readable — a crew member should be
 * able to read what "On our way" actually says before it goes out under the
 * company's name.
 */
export async function fetchTemplates(options?: {
  includeInactive?: boolean;
}): Promise<MessageTemplate[]> {
  try {
    let query = supabase
      .from('message_templates')
      .select('id, company, key, title, body, channel, active, sort')
      .eq('company', COMPANY);
    if (!options?.includeInactive) query = query.eq('active', true);
    const { data, error } = await query.order('sort', { ascending: true });
    if (error || !data) return [];
    return (data as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      company: (row.company as string) ?? COMPANY,
      key: (row.key as string) ?? '',
      title: (row.title as string) ?? '',
      body: (row.body as string) ?? '',
      channel: (row.channel as string) ?? 'sms',
      active: row.active !== false,
      sort: row.sort != null ? Number(row.sort) : 0,
    }));
  } catch {
    return [];
  }
}

export interface TemplateInput {
  key: string;
  title: string;
  body: string;
  active?: boolean;
  sort?: number;
}

/** Admin: add a template. The unique key is (company, key). */
export async function createTemplate(input: TemplateInput): Promise<CommsResult> {
  try {
    const key = input.key.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    if (!key) return { ok: false, message: 'Give the template a short key, like "on_my_way".' };
    if (!input.title.trim()) return { ok: false, message: 'Give the template a title.' };
    if (!input.body.trim()) return { ok: false, message: 'The template needs some text.' };
    const { error } = await supabase.from('message_templates').insert({
      company: COMPANY,
      key,
      title: input.title.trim(),
      body: input.body.trim(),
      active: input.active ?? true,
      sort: input.sort ?? 100,
    });
    if (error) return { ok: false, message: templateError(error) };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the template.' };
  }
}

/** Admin: edit a template. */
export async function updateTemplate(
  id: string,
  patch: Partial<TemplateInput>,
): Promise<CommsResult> {
  try {
    const update: Record<string, unknown> = {};
    if (patch.title !== undefined) update.title = patch.title.trim();
    if (patch.body !== undefined) update.body = patch.body.trim();
    if (patch.active !== undefined) update.active = patch.active;
    if (patch.sort !== undefined) update.sort = patch.sort;
    if (Object.keys(update).length === 0) return { ok: true };
    const { data, error } = await supabase
      .from('message_templates')
      .update(update)
      .eq('id', id)
      .select('id');
    if (error) return { ok: false, message: templateError(error) };
    if (!data || data.length === 0) {
      return { ok: false, message: 'Only owners and operators can change the saved texts.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the template.' };
  }
}

/** Admin: delete a template. */
export async function deleteTemplate(id: string): Promise<CommsResult> {
  try {
    const { error } = await supabase.from('message_templates').delete().eq('id', id);
    if (error) return { ok: false, message: templateError(error) };
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the template.' };
  }
}

function templateError(error: { code?: string; message?: string }): string {
  const raw = error.message ?? '';
  if (error.code === '23505' || /duplicate key|unique constraint/i.test(raw)) {
    return 'A saved text with that key already exists — pick a different key.';
  }
  if (error.code === '42501' || /row-level security|policy|permission denied/i.test(raw)) {
    return 'Only owners and operators can change the saved texts.';
  }
  return raw || 'Could not save the template.';
}

// ---------------------------------------------------------------------------
// Merge fields
// ---------------------------------------------------------------------------

export interface TemplateVars {
  customer_first?: string | null;
  customer_name?: string | null;
  /** Alias kept because the seeded templates say {{customer}}. */
  customer?: string | null;
  address?: string | null;
  job_number?: string | null;
  tech?: string | null;
  eta?: string | null;
  date?: string | null;
  time_suffix?: string | null;
  /** Alias kept because the seeded reminder template says {{time}}. */
  time?: string | null;
  document_number?: string | null;
  amount?: string | null;
  review_link?: string | null;
  company_phone?: string | null;
}

/**
 * Fill a template's `{{merge_fields}}`.
 *
 * ANY TOKEN WE CANNOT RESOLVE IS REMOVED, not left as literal braces. A text
 * that goes out saying "on the way to {{address}}" is worse than one that
 * simply does not mention the address, and the composer previews the result
 * before anything is sent, so a gap is visible and editable. Whitespace is
 * tidied afterwards — double spaces, a space before a comma or full stop, and
 * the empty line a removed token can leave behind.
 */
export function renderTemplate(body: string, vars: TemplateVars): string {
  const lookup: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (typeof value === 'string' && value.trim().length > 0) lookup[name] = value.trim();
  }
  // Aliases, so a template may say either spelling.
  if (!lookup.customer && lookup.customer_name) lookup.customer = lookup.customer_name;
  if (!lookup.customer_name && lookup.customer) lookup.customer_name = lookup.customer;
  if (!lookup.time && lookup.time_suffix) lookup.time = lookup.time_suffix;
  if (!lookup.time_suffix && lookup.time) lookup.time_suffix = lookup.time;

  const filled = body.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, token: string) => {
    const value = lookup[token.toLowerCase()];
    return value ?? '';
  });

  return tidyText(filled);
}

/**
 * Clean up after a removed token. Deliberately conservative: it fixes the
 * artefacts stripping produces (double spaces, orphaned punctuation, a blank
 * line) and touches nothing else, because this text is about to be sent to a
 * customer under the company's name.
 */
function tidyText(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ([,.!?;:])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** The bits of a job a template can mention. Structural subset of CustomerJob. */
export interface TemplateJobLike {
  job_number?: string | null;
  address?: string | null;
  scheduled_for?: string | null;
}

/** The bits of a customer a template can mention. */
export interface TemplateCustomerLike {
  name?: string | null;
  address?: string | null;
}

/**
 * Assemble the merge fields from what a screen already has loaded. Anything
 * missing simply stays unresolved and gets stripped, so partial context is a
 * normal input rather than an error.
 */
export function buildTemplateVars(input: {
  customer?: TemplateCustomerLike | null;
  job?: TemplateJobLike | null;
  settings?: CommsSettings | null;
  tech?: string | null;
  documentNumber?: string | null;
  amount?: string | null;
  eta?: string | null;
}): TemplateVars {
  const name = input.customer?.name?.trim() ?? '';
  const first = name.split(/\s+/)[0] ?? '';
  return {
    customer_first: first || null,
    customer_name: name || null,
    customer: name || null,
    address: input.job?.address ?? input.customer?.address ?? null,
    job_number: input.job?.job_number ?? null,
    tech: input.tech ?? null,
    eta: input.eta ?? null,
    date: input.job?.scheduled_for ? formatTemplateDate(input.job.scheduled_for) : null,
    time_suffix: null,
    time: null,
    document_number: input.documentNumber ?? null,
    amount: input.amount ?? null,
    review_link: input.settings?.reviewLink ?? null,
    company_phone: COMPANY_PHONE,
  };
}

/** "2026-08-25" → "Tue, Aug 25". Local parse; never a UTC off-by-one. */
function formatTemplateDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

let channelSeq = 0;

/**
 * Live `messages` changes, for the inbox and one open thread.
 *
 * NOT A SOURCE OF TRUTH. Every screen that uses this also refetches on focus.
 * A websocket that dropped while the phone was in a pocket must cost a few
 * seconds of staleness, never a message nobody ever sees.
 *
 * Realtime evaluates RLS per subscriber and `messages` is admin-only, so a
 * viewer's socket receives nothing — the subscription is harmless for them
 * rather than something to gate in the UI.
 *
 * Re-subscribes on auth changes because a channel opened before sign-in
 * carries no user and would stay silent forever afterwards. `removeChannel` on
 * unmount: leaking a channel per screen visit exhausts the connection's
 * channel budget within a shift of ordinary use.
 */
export function useCommsRealtime(onChange: () => void, customerId?: string | null): void {
  // Keep the latest callback without making it a subscription dependency —
  // an inline arrow from a screen changes identity every render, and
  // re-subscribing on every render is how you get a socket storm.
  const handler = useRef(onChange);
  handler.current = onChange;

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    const subscribe = () => {
      if (cancelled) return;
      if (channel) {
        void supabase.removeChannel(channel);
        channel = null;
      }
      channelSeq += 1;
      const name = `comms-messages-${customerId ?? 'all'}-${channelSeq}`;
      try {
        const next = supabase.channel(name).on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'messages',
            ...(customerId ? { filter: `customer_id=eq.${customerId}` } : {}),
          },
          () => {
            handler.current();
          },
        );
        next.subscribe();
        channel = next;
      } catch {
        // No live updates on this device. Focus refetch still covers it.
      }
    };

    subscribe();

    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      subscribe();
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [customerId]);
}
