// Supabase Edge Function: notify — fan out a push notification to the
// crew's registered devices (push_tokens, migration 9).
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy new function →
// name it `notify`, paste this file, and UNCHECK "Verify JWT" (callers
// authenticate with the shared secret below instead). Then add the secret:
// Edge Functions → notify → Secrets → NOTIFY_SECRET = a long random string.
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are provided automatically.
//
// Callers must send header  x-notify-secret: <NOTIFY_SECRET>.
//
// Accepted POST bodies (all JSON):
//   { title, body, emails? , audience? }   direct push (emails wins over audience)
//   { from, subject, snippet, messageId?, date?, body?, backfill? }
//     email-triggered (Gmail Apps Script). When the text parses as a bank/GC
//     transaction, a finance_entries row is inserted (deduped by messageId,
//     tagged extracted.source = 'email-scanner') so the app's financials
//     update automatically. backfill: true logs the entry WITHOUT pushing.
//   { type: "INSERT", record: {...} }      Supabase database webhooks:
//     - finance_entries payment inserts  → 💰 push to admins
//       (skipped for extracted.source = 'email-scanner' rows — the email
//        path already pushed; prevents double notifications)
//     - job_assignments inserts          → 🔧 push to the assigned member
//     - leads inserts with source_ref    → 🌐 push to admins (CRM Phase 10:
//       an automatic lead — website quote form — arrived; typed-in leads
//       never reach here, the trigger has WHEN source_ref IS NOT NULL)
//
// audience: "admins" (default — owner/operator only; bank alerts are
// admin business) or "all" (whole crew).

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const COMPANY = 'dc-solar';

/**
 * THE NOTIFICATION TARGET CONTRACT (2026-09-08). Every push carries a `data`
 * object that says what the notification is ABOUT, with stable ids, so a tap
 * can open the exact screen — never a name or a number to be looked up
 * later. The app's `lib/notificationTargets.ts` is the other half of this
 * contract; keep the two in step.
 *
 *   sms_thread   { customerId?, leadId?, contactId?, phone?, name? }
 *   call         { customerId?, leadId?, contactId?, phone?, name? }  (missed call → same thread)
 *   lead         { leadId }
 *   customer     { customerId }
 *   job          { jobId }
 *   task         { taskId, leadId?, customerId? }
 *   appointment  { appointmentId, leadId }
 *
 * Values are strings only (Expo delivers `data` as JSON; iOS keeps it small).
 * Nothing else goes in here: no notes, no bodies, no secrets.
 */
// 'storm' (2026-10-09): { day } — opens that storm's report.
//
// 2026-11-08: the contract widened (schedule, email_thread, prospects,
// financials, inbox, test; `day` on appointments) and the server now checks
// each type EXACTLY as app/src/lib/notificationTargets.ts parses it — a
// target the app would drop is never sent (it used to fail silently as
// "no target" on the phone).
type TargetType =
  | 'sms_thread' | 'call' | 'lead' | 'customer' | 'job' | 'schedule' | 'task' | 'appointment'
  | 'storm' | 'email_thread' | 'prospects' | 'financials' | 'inbox' | 'test';
type Target = { type: TargetType } & Record<string, string>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const THREAD_RE = /^[A-Za-z0-9_-]{6,64}$/;

type Rule = { required: Record<string, RegExp | null>; optional: Record<string, RegExp | null> };
const ANY: RegExp | null = null;
/** Per type: required and optional keys, with the format each must match (null = any short string). */
const TARGET_RULES: Record<TargetType, Rule> = {
  sms_thread: { required: {}, optional: { customerId: UUID_RE, leadId: UUID_RE, contactId: UUID_RE, phone: ANY, name: ANY } },
  call: { required: {}, optional: { customerId: UUID_RE, leadId: UUID_RE, contactId: UUID_RE, phone: ANY, name: ANY } },
  lead: { required: { leadId: UUID_RE }, optional: {} },
  customer: { required: { customerId: UUID_RE }, optional: {} },
  job: { required: { jobId: UUID_RE }, optional: {} },
  schedule: { required: { jobId: UUID_RE, day: DAY_RE }, optional: {} },
  task: { required: { taskId: UUID_RE }, optional: { leadId: UUID_RE, customerId: UUID_RE } },
  appointment: { required: { appointmentId: UUID_RE }, optional: { leadId: UUID_RE, day: DAY_RE } },
  storm: { required: { day: DAY_RE }, optional: {} },
  email_thread: { required: { threadId: THREAD_RE }, optional: {} },
  prospects: { required: {}, optional: {} },
  financials: { required: {}, optional: {} },
  inbox: { required: {}, optional: {} },
  test: { required: {}, optional: {} },
};

/** Accept a target only if it is exactly the contract; null otherwise (and say why in the log). */
function sanitizeTarget(raw: unknown): Target | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const type = String(input.type ?? '') as TargetType;
  const rule = TARGET_RULES[type];
  if (!rule) {
    if (input.type !== undefined) console.warn('notify: dropped target of unknown type', String(input.type));
    return null;
  }
  const out: Record<string, string> = { type };
  const ok = (key: string, re: RegExp | null): boolean => {
    const v = input[key];
    if (typeof v !== 'string' || v.length === 0 || v.length > 200) return false;
    return re ? re.test(v) : true;
  };
  for (const [key, re] of Object.entries(rule.required)) {
    if (!ok(key, re)) {
      console.warn('notify: dropped target missing/bad', type, key);
      return null;
    }
    out[key] = String(input[key]);
  }
  for (const [key, re] of Object.entries(rule.optional)) {
    if (ok(key, re)) out[key] = String(input[key]);
  }
  if ((type === 'sms_thread' || type === 'call') && !out.customerId && !out.leadId && !out.contactId && !out.phone) {
    return null;
  }
  return out as Target;
}

interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
  priority: 'high';
  data?: Target;
  badge?: number;
}

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** PostgREST GET with the service role (bypasses RLS). */
async function rest(path: string): Promise<Record<string, unknown>[] | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, authorization: `Bearer ${key}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>[];
}

/** PostgREST insert with the service role. Returns the inserted rows or null. */
async function restPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>[] | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      prefer: 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>[];
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** "Chase Bank <no.reply.alerts@chase.com>" → "Chase Bank". */
function fromName(from: string): string {
  const match = from.match(/^\s*"?([^"<]+?)"?\s*</);
  return (match ? match[1] : from).trim();
}

const MONEY_WORDS =
  /payment|deposit|remittance|paid|credit|purchase|transaction|debit|withdrawal|charge|transfer/i;

// ---------------------------------------------------------------------------
// Email → finance_entries transaction parsing
// ---------------------------------------------------------------------------

const IN_WORDS =
  /\bdeposit(?:ed)?\b|remittance|payment (?:received|from)|paid you|has paid|invoice paid|ach credit|credited to your|funds (?:received|available)|direct deposit/i;
const OUT_WORDS =
  /purchase|debit card|withdrawal|charge(?:d)? to|check (?:no|#|number|cleared)|wire (?:sent|transfer sent)|payment to|you (?:sent|paid)|ach (?:payment|withdrawal|debit)|card transaction/i;

interface ParsedTransaction {
  type: 'payment' | 'expense';
  direction: 'in' | 'out';
  amount: number;
  keyword: string;
}

/**
 * Classify + extract the dollar amount from an alert email. Prefers the
 * amount closest to a money keyword; falls back to the largest amount.
 * Returns null when there's no amount or no clear in/out signal — those
 * emails still push a notification, they just don't log an entry.
 */
function parseTransaction(text: string): ParsedTransaction | null {
  let amounts = [...text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/g)]
    .map((m) => ({ value: Number(m[1].replaceAll(',', '')), index: m.index ?? 0 }))
    .filter((a) => Number.isFinite(a.value) && a.value > 0);
  // Account balances aren't transaction amounts ("Balance: $52,301.11").
  const nonBalance = amounts.filter(
    (a) => !/balance[^$]{0,20}$/i.test(text.slice(Math.max(0, a.index - 30), a.index)),
  );
  if (nonBalance.length > 0) amounts = nonBalance;
  if (amounts.length === 0) return null;

  const inMatch = text.match(IN_WORDS);
  const outMatch = text.match(OUT_WORDS);
  let incoming: boolean;
  let keywordMatch: RegExpMatchArray;
  if (inMatch && outMatch) {
    // Both matched (e.g. "payment to" + "deposit") — trust whichever appears first.
    incoming = (inMatch.index ?? 0) <= (outMatch.index ?? 0);
    keywordMatch = incoming ? inMatch : outMatch;
  } else if (inMatch) {
    incoming = true;
    keywordMatch = inMatch;
  } else if (outMatch) {
    incoming = false;
    keywordMatch = outMatch;
  } else {
    return null;
  }

  const kwIndex = keywordMatch.index ?? 0;
  const nearest = [...amounts].sort(
    (a, b) => Math.abs(a.index - kwIndex) - Math.abs(b.index - kwIndex),
  )[0];
  const largest = [...amounts].sort((a, b) => b.value - a.value)[0];
  // Within 200 chars of the keyword → trust proximity; otherwise take the largest.
  const amount = Math.abs(nearest.index - kwIndex) <= 200 ? nearest.value : largest.value;

  return {
    type: incoming ? 'payment' : 'expense',
    direction: incoming ? 'in' : 'out',
    amount,
    keyword: keywordMatch[0],
  };
}

/**
 * The DC Solar Company container job (jobs.is_internal). Company overhead is
 * tagged to it rather than left with a null job_id, so there is exactly ONE
 * way to say "this is overhead" (2026-08-05). Null if it's ever removed, in
 * which case we fall back to the old null-job behaviour.
 */
async function companyJobId(): Promise<string | null> {
  const rows = (await rest(
    `jobs?company=eq.${COMPANY}&is_internal=is.true&select=id&limit=1`,
  )) as { id: string }[] | null;
  return rows && rows.length > 0 ? rows[0].id : null;
}

/** Find the job this email is about: DC-26### number first, then job name. */
async function matchJob(text: string): Promise<{ id: string; job_number: string | null } | null> {
  const numberMatch = text.match(/\bDC-\d{5}\b/i);
  const jobs = (await rest(
    `jobs?company=eq.${COMPANY}&select=id,job_number,name`,
  )) as { id: string; job_number: string | null; name: string | null }[] | null;
  if (!jobs) return null;

  if (numberMatch) {
    const wanted = numberMatch[0].toUpperCase();
    const hit = jobs.find((j) => (j.job_number ?? '').toUpperCase() === wanted);
    if (hit) return hit;
  }

  const lower = text.toLowerCase();
  const nameHits = jobs.filter(
    (j) => (j.name ?? '').trim().length >= 5 && lower.includes(j.name!.trim().toLowerCase()),
  );
  return nameHits.length === 1 ? nameHits[0] : null;
}

/**
 * Insert the finance_entries row for a parsed email transaction.
 * Dedupes on the Gmail message id so backfills can re-run safely.
 * Returns 'logged', 'duplicate', or 'error'.
 */
async function logEmailTransaction(params: {
  parsed: ParsedTransaction;
  from: string;
  subject: string;
  text: string;
  messageId: string | null;
  date: string | null;
}): Promise<'logged' | 'duplicate' | 'error'> {
  const { parsed, from, subject, text, messageId, date } = params;

  if (messageId) {
    const existing = await rest(
      `finance_entries?company=eq.${COMPANY}&extracted->>gmail_message_id=eq.${encodeURIComponent(messageId)}&select=id&limit=1`,
    );
    if (existing === null) return 'error';
    if (existing.length > 0) return 'duplicate';
  }

  const job = await matchJob(text);
  const occurredOn =
    date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : new Date().toISOString().slice(0, 10);

  // A payment of the same amount within ±3 days is the same money — e.g.
  // Devon logged it manually before the bank email arrived. Skip the insert.
  // Expenses are exempt: two identical purchases days apart can be real.
  if (parsed.type === 'payment') {
    const day = new Date(`${occurredOn}T12:00:00Z`).getTime();
    const lo = new Date(day - 3 * 86400000).toISOString().slice(0, 10);
    const hi = new Date(day + 3 * 86400000).toISOString().slice(0, 10);
    const similar = await rest(
      `finance_entries?company=eq.${COMPANY}&type=eq.payment&amount=eq.${parsed.amount}&occurred_on=gte.${lo}&occurred_on=lte.${hi}&select=id&limit=1`,
    );
    if (similar === null) return 'error';
    if (similar.length > 0) return 'duplicate';
  }

  const inserted = await restPost('finance_entries', {
    company: COMPANY,
    type: parsed.type,
    direction: parsed.direction,
    amount: parsed.amount,
    currency: 'USD',
    description: truncate(subject, 140),
    occurred_on: occurredOn,
    status: 'recorded',
    // Unmatched email => company overhead => the container job.
    job_id: job?.id ?? (await companyJobId()),
    counterparty: fromName(from),
    extracted: {
      source: 'email-scanner',
      gmail_message_id: messageId,
      from,
      subject: truncate(subject, 200),
      keyword: parsed.keyword,
      matched_job: job?.job_number ?? null,
    },
  });
  return inserted ? 'logged' : 'error';
}

interface OutboundMessage {
  title: string;
  body: string;
  emails: string[] | null;
  audience: 'admins' | 'all';
  /** Where a tap goes. Optional: an informational push may have nowhere to go. */
  target?: Target;
  /**
   * The person's own switch for this kind of push (2026-10-06, rep Settings →
   * Notifications): staff_profiles.notify_<pref>. Anyone in `emails` who turned
   * it off is dropped. Admin-audience pushes ignore it.
   */
  pref?: Pref;
  /**
   * Stable id for this alert (2026-11-08). With one, the Alerts row is
   * inserted ON CONFLICT DO NOTHING and only recipients whose row was NEW get
   * the push — so a reminder or a retried webhook never pushes twice.
   */
  dedupe?: string;
  /** Where it came from, for the Alerts row and the log ('tasks:INSERT', 'twilio-inbound'…). */
  source?: string;
}

type Pref = 'texts' | 'missed_calls' | 'new_prospects' | 'storms' | 'tasks' | 'schedule';
const PREFS = new Set<string>(['texts', 'missed_calls', 'new_prospects', 'storms', 'tasks', 'schedule']);

/** Normalize any accepted body shape into {title, body, emails?, audience, target?}. */
function normalize(payload: Record<string, unknown>): OutboundMessage | null {
  // Database webhook shape (finance_entries INSERT).
  if (payload.type === 'INSERT' && payload.record && typeof payload.record === 'object') {
    const record = payload.record as Record<string, unknown>;
    // Only a finance_entries payment that is actually recorded (2026-11-08:
    // the table is checked — any future triggered table with a `type`
    // column would otherwise announce "Payment recorded" — and void /
    // draft rows stay quiet).
    if (payload.table !== 'finance_entries') return null;
    if (record.type !== 'payment') return null; // only payments push
    if (record.status && record.status !== 'recorded') return null;
    // Email-scanner inserts already pushed via the email path — don't double up.
    const extracted = record.extracted as Record<string, unknown> | null | undefined;
    if (extracted && extracted.source === 'email-scanner') return null;
    const amount = Number(record.amount);
    const who = typeof record.counterparty === 'string' ? record.counterparty : 'customer';
    return {
      title: '💰 Payment recorded',
      body: `$${Number.isFinite(amount) ? amount.toLocaleString('en-US') : '?'} from ${who}`,
      emails: null,
      audience: 'admins',
      // A payment with no job (a manual deposit) opens Financials.
      target: typeof record.job_id === 'string' ? { type: 'job', jobId: record.job_id } : { type: 'financials' },
      dedupe: typeof record.id === 'string' ? `payment:${record.id}` : undefined,
      source: 'finance_entries:INSERT',
    };
  }

  // Gmail Apps Script shape.
  if (typeof payload.subject === 'string' && typeof payload.from === 'string') {
    const subject = truncate(payload.subject, 100);
    const snippet = typeof payload.snippet === 'string' ? truncate(payload.snippet, 140) : '';
    const emoji = MONEY_WORDS.test(`${payload.subject} ${payload.snippet ?? ''}`) ? '💰' : '📬';
    // A tap opens the Gmail thread when the script sends its id, else the
    // money screen for a money email, else the inbox (2026-11-08: these
    // pushes carried no target and a tap opened nothing).
    const threadTarget = sanitizeTarget({ type: 'email_thread', threadId: payload.threadId });
    return {
      title: `${emoji} ${subject}`,
      body: snippet ? `${fromName(payload.from)} — ${snippet}` : fromName(payload.from),
      emails: null,
      audience: 'admins',
      target: threadTarget ?? (emoji === '💰' ? { type: 'financials' } : { type: 'inbox' }),
      dedupe: typeof payload.messageId === 'string' ? `gmail:${payload.messageId}` : undefined,
      source: 'gmail',
    };
  }

  // Direct shape (twilio-inbound, twilio-voice-inbound, scripts). `target`
  // is honoured only when it matches the contract exactly.
  if (typeof payload.title === 'string' && typeof payload.body === 'string') {
    const emails =
      Array.isArray(payload.emails) && payload.emails.every((e) => typeof e === 'string')
        ? (payload.emails as string[])
        : null;
    const pref = typeof payload.pref === 'string' && PREFS.has(payload.pref) ? (payload.pref as Pref) : undefined;
    return {
      title: truncate(payload.title, 100),
      body: truncate(payload.body, 200),
      emails,
      audience: payload.audience === 'all' ? 'all' : 'admins',
      target: sanitizeTarget(payload.target) ?? undefined,
      pref,
      dedupe: typeof payload.dedupe === 'string' && payload.dedupe.length <= 200 ? payload.dedupe : undefined,
      source: typeof payload.source === 'string' ? payload.source.slice(0, 60) : 'direct',
    };
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const secret = Deno.env.get('NOTIFY_SECRET');
  if (!secret || req.headers.get('x-notify-secret') !== secret) {
    return json(401, { error: 'bad secret' });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: 'invalid JSON' });
  }

  // Cron (notify-reminders): task-due and appointment reminders.
  if (payload.action === 'reminders') return json(200, await runReminders());

  // --- Email payloads: log parseable transactions into finance_entries ---
  let logged: 'logged' | 'duplicate' | 'error' | null = null;
  if (typeof payload.subject === 'string' && typeof payload.from === 'string') {
    const bodyText =
      typeof payload.body === 'string'
        ? payload.body
        : typeof payload.snippet === 'string'
          ? payload.snippet
          : '';
    const fullText = `${payload.subject}\n${bodyText}`;
    const parsed = parseTransaction(fullText);
    if (parsed) {
      logged = await logEmailTransaction({
        parsed,
        from: payload.from,
        subject: payload.subject,
        text: fullText,
        messageId: typeof payload.messageId === 'string' ? payload.messageId : null,
        date: typeof payload.date === 'string' ? payload.date : null,
      });
    }
    // Backfill mode: record the entry, never push (avoids a storm of old alerts).
    if (payload.backfill === true) {
      return json(200, { sent: 0, logged: logged ?? 'not-a-transaction' });
    }
  }

  // --- Database webhook payloads (assignments + schedule changes) -------
  let message = normalize(payload);
  const table = payload.table as string | undefined;
  const op = payload.type as string | undefined;
  const record = payload.record as Record<string, unknown> | undefined;
  const oldRecord = payload.old_record as Record<string, unknown> | undefined;

  const jobLabel = async (jobId: unknown): Promise<string> => {
    if (typeof jobId !== 'string') return 'a job';
    const jobs = await rest(`jobs?id=eq.${jobId}&select=job_number,name,address&limit=1`);
    const job = jobs?.[0] as
      | { job_number?: string | null; name?: string; address?: string | null }
      | undefined;
    if (!job) return 'a job';
    let label = [job.job_number, job.name].filter(Boolean).join(' — ') || 'a job';
    if (job.address) label += ` (${job.address})`;
    return label;
  };
  const assignedEmails = async (jobId: unknown): Promise<string[]> => {
    if (typeof jobId !== 'string') return [];
    const rows = await rest(`job_assignments?job_id=eq.${jobId}&select=email`);
    return (rows ?? []).map((r) => String(r.email)).filter(Boolean);
  };
  const prettyDate = (iso: unknown): string => {
    if (typeof iso !== 'string') return 'a new date';
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime())
      ? String(iso)
      : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  };
  const prettyTime = (hms: unknown): string => {
    if (typeof hms !== 'string') return '';
    const [h, m] = hms.split(':').map(Number);
    if (!Number.isFinite(h)) return '';
    const ampm = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return ` · ${hour12}:${`${m || 0}`.padStart(2, '0')} ${ampm}`;
  };

  const jobTarget = (jobId: unknown): Target | undefined =>
    typeof jobId === 'string' ? { type: 'job', jobId } : undefined;
  /** The calendar on `day` (falls back to the job page when the day is unusable). */
  const scheduleTarget = (jobId: unknown, day: unknown): Target | undefined =>
    sanitizeTarget({ type: 'schedule', jobId, day }) ?? jobTarget(jobId);
  const src = table && op ? `${table}:${op}` : undefined;
  const rid = typeof record?.id === 'string' ? record.id : undefined;
  const txid = typeof payload.txid === 'string' ? payload.txid : '';
  const lower = (v: unknown): string => String(v ?? '').toLowerCase();

  if (!message && table === 'job_assignments' && record?.email) {
    const label = await jobLabel(record.job_id);
    if (op === 'INSERT') {
      message = {
        title: '🔧 New job assignment',
        body: truncate(`You've been assigned to ${label}.`, 200),
        emails: [lower(record.email)],
        audience: 'admins',
        target: jobTarget(record.job_id),
        dedupe: rid ? `assign:${rid}` : undefined,
        source: src,
      };
    } else if (op === 'DELETE') {
      // Taken off the job (or the job was deleted): the job page may no
      // longer be theirs to open — the calendar is (2026-11-08).
      message = {
        title: '🔧 Removed from job',
        body: truncate(`You've been taken off ${label}.`, 200),
        emails: [lower(record.email)],
        audience: 'admins',
        target: scheduleTarget(record.job_id, centralToday()),
        pref: 'schedule',
        dedupe: rid ? `unassign:${rid}:${txid}` : undefined,
        source: src,
      };
    }
  }

  if (!message && table === 'leads' && op === 'INSERT' && typeof record?.source_ref === 'string') {
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'Someone';
    const contact =
      (typeof record.phone === 'string' && record.phone.trim()) ||
      (typeof record.email === 'string' && record.email.trim()) ||
      'no phone or email';
    const source = typeof record.source === 'string' && record.source ? record.source : 'Website';
    message = {
      title: `🌐 New ${source.toLowerCase()} lead`,
      body: truncate(`${name} · ${contact}. A follow-up task is waiting in the CRM.`, 200),
      emails: null,
      audience: 'admins',
      target: rid ? { type: 'lead', leadId: rid } : undefined,
      dedupe: rid ? `lead_new:${rid}` : undefined,
      source: src,
    };
  }

  // A batch of pool leads handed to a rep at once (2026-10-07, assign_leads):
  // one push for the whole batch, not one per lead. Opens their Prospects.
  if (!message && table === 'lead_assignment_batches' && op === 'INSERT' && typeof record?.rep_email === 'string') {
    const n = Number(record.lead_count ?? 0);
    message = {
      title: `🧲 ${n} new prospect${n === 1 ? '' : 's'} for you`,
      body: 'They are in your CRM under Prospects. Imported leads are call-first.',
      emails: [lower(record.rep_email)],
      audience: 'admins',
      target: { type: 'prospects' },
      pref: 'new_prospects',
      dedupe: rid ? `batch:${rid}` : undefined,
      source: src,
    };
  }

  // Developer Tools → "Send me a test notification" (2026-10-08, dev_test_push).
  if (!message && table === 'dev_test_pushes' && op === 'INSERT' && typeof record?.email === 'string') {
    message = {
      title: '🔔 Test notification',
      body: 'If you can see this, notifications reach this phone. Tap it to check taps too.',
      emails: [lower(record.email)],
      audience: 'admins',
      target: { type: 'test' },
      source: src,
    };
  }

  // A lead assigned to someone (2026-10-06): a new lead created for them, or a
  // reassignment. The trigger (leads_assigned_notify_*) already skips
  // self-assignment, e.g. a rep adding their own prospect.
  if (
    !message &&
    table === 'leads' &&
    typeof record?.assigned_to === 'string' &&
    record.assigned_to &&
    (op === 'UPDATE' || (op === 'INSERT' && !record.source_ref))
  ) {
    const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'A new prospect';
    const contact = (typeof record.phone === 'string' && record.phone.trim()) || '';
    message = {
      title: '🧲 New prospect for you',
      body: truncate(contact ? `${name} · ${contact}` : name, 200),
      emails: [lower(record.assigned_to)],
      audience: 'admins',
      target: rid ? { type: 'lead', leadId: rid } : undefined,
      pref: 'new_prospects',
      dedupe: rid ? `lead_assigned:${rid}:${lower(record.assigned_to)}:${txid}` : undefined,
      source: src,
    };
  }

  // A task handed to someone (INSERT with an assignee, or an UPDATE that
  // changes the assignee). The person who assigned it to themselves is not
  // told twice; automation-created tasks reach the assignee like any other.
  if (!message && table === 'tasks' && typeof record?.assigned_to === 'string' && record.assigned_to) {
    const assignee = lower(record.assigned_to);
    const reassigned = op === 'UPDATE' && lower(oldRecord?.assigned_to) === assignee;
    const selfAssigned =
      (op === 'INSERT' && lower(record.created_by) === assignee) ||
      (op === 'UPDATE' && lower(record.updated_by) === assignee);
    if ((op === 'INSERT' || op === 'UPDATE') && !reassigned && !selfAssigned) {
      const title = typeof record.title === 'string' ? record.title : 'a task';
      const target: Target = { type: 'task', taskId: String(record.id) };
      if (typeof record.lead_id === 'string') target.leadId = record.lead_id;
      if (typeof record.customer_id === 'string') target.customerId = record.customer_id;
      message = {
        title: '✅ Task for you',
        body: truncate(title, 200),
        emails: [assignee],
        audience: 'admins',
        target,
        pref: 'tasks',
        dedupe: rid ? `task_assigned:${rid}:${assignee}:${txid}` : undefined,
        source: src,
      };
    }
  }

  // Lead appointments (2026-11-08): given to someone, MOVED, CANCELED, or
  // DELETED. The person who made the change is not told about it.
  if (!message && table === 'lead_appointments') {
    const now = op === 'DELETE' ? oldRecordOrRecord(record, oldRecord) : record;
    const assignee = lower(now?.assigned_to);
    if (assignee) {
      const leads = typeof now?.lead_id === 'string' ? await rest(`leads?id=eq.${now.lead_id}&select=name&limit=1`) : null;
      const leadName = (leads?.[0] as { name?: string } | undefined)?.name ?? 'a lead';
      const kind = String(now?.kind ?? 'appointment').replace('_', ' ');
      const when = `${prettyDate(now?.appt_date)}${prettyTime(now?.start_time)}`;
      const target = sanitizeTarget({
        type: 'appointment',
        appointmentId: now?.id,
        leadId: now?.lead_id,
        day: now?.appt_date,
      }) ?? undefined;
      let title: string | null = null;
      let body = '';
      let pref: Pref | undefined;
      if (op === 'INSERT') {
        if (lower(record?.created_by) !== assignee) {
          title = '📅 Appointment for you';
          body = `${kind} with ${leadName} · ${when}`;
        }
      } else if (op === 'UPDATE') {
        const byThem = lower(record?.updated_by) === assignee;
        const reassigned = lower(oldRecord?.assigned_to) !== assignee;
        const canceled = record?.outcome === 'canceled' && oldRecord?.outcome !== 'canceled';
        const moved = record?.appt_date !== oldRecord?.appt_date || record?.start_time !== oldRecord?.start_time;
        if (!byThem) {
          if (reassigned) {
            title = '📅 Appointment for you';
            body = `${kind} with ${leadName} · ${when}`;
          } else if (canceled) {
            title = '❌ Appointment canceled';
            body = `${kind} with ${leadName} · ${when}`;
            pref = 'schedule';
          } else if (moved) {
            title = '📅 Appointment moved';
            body = `${kind} with ${leadName} → ${when}`;
            pref = 'schedule';
          }
        }
      } else if (op === 'DELETE') {
        title = '❌ Appointment removed';
        body = `${kind} with ${leadName} · ${when}`;
        pref = 'schedule';
      }
      if (title) {
        message = {
          title,
          body: truncate(body, 200),
          emails: [assignee],
          audience: 'admins',
          target,
          pref,
          dedupe: `appt:${String(now?.id)}:${op}:${txid}`,
          source: src,
        };
      }
    }
  }

  if (!message && table === 'job_schedule_dates' && record?.job_id) {
    // Only ping when the date or start time actually changed.
    const changed =
      op !== 'UPDATE' ||
      record.work_date !== oldRecord?.work_date ||
      record.start_time !== oldRecord?.start_time;
    if (changed && (op === 'INSERT' || op === 'UPDATE' || op === 'DELETE')) {
      const emails = (await assignedEmails(record.job_id)).map(lower);
      if (emails.length === 0) {
        return json(200, { sent: 0, skipped: 'no crew assigned to this job' });
      }
      const label = await jobLabel(record.job_id);
      const when = `${prettyDate(record.work_date)}${prettyTime(record.start_time)}`;
      let body =
        op === 'INSERT'
          ? `${label} scheduled for ${when}.`
          : op === 'UPDATE'
            ? `${label} moved to ${when}.`
            : `${label}: the ${prettyDate(record.work_date)} work day was removed.`;
      let day = record.work_date;
      let dedupe = `sched:${rid}:${op}:${txid}`;
      // "Several days" (2026-10-14) inserts many days in ONE statement: they
      // share created_at exactly (now() is the transaction's start). ONE push
      // for the batch, naming the range. 2026-11-08: the batch is found by
      // that exact created_at and the push deduped per transaction — the old
      // ±15 s window merged two separate adds and could drop the second.
      if (op === 'INSERT' && typeof record.created_at === 'string') {
        const batch = (await rest(
          `job_schedule_dates?job_id=eq.${record.job_id}&created_at=eq.${encodeURIComponent(record.created_at)}&select=id,work_date,start_time&order=work_date.asc`,
        )) as unknown as { id: string; work_date: string; start_time: string | null }[] | null;
        if (batch && batch.length > 1) {
          body = `${label} scheduled for ${batch.length} days: ${prettyDate(batch[0].work_date)} – ${prettyDate(
            batch[batch.length - 1].work_date,
          )}${prettyTime(record.start_time)}.`;
          day = batch[0].work_date;
          dedupe = `sched_batch:${record.job_id}:${record.created_at}`;
        }
      }
      message = {
        title: op === 'DELETE' ? '📅 Schedule change' : '📅 Job scheduled',
        body: truncate(body, 200),
        emails,
        audience: 'admins',
        target: scheduleTarget(record.job_id, day),
        pref: 'schedule',
        dedupe,
        source: src,
      };
    }
  }

  // An outbound text that failed (2026-11-08): tell whoever sent it.
  if (!message && table === 'messages' && op === 'UPDATE' && record) {
    const who = await recordName(record.customer_id, record.lead_id, record.contact_id);
    const to = typeof record.to_number === 'string' ? record.to_number : '';
    const reason = typeof record.error === 'string' && record.error ? record.error : `status ${String(record.status)}`;
    const sender = lower(record.sent_by);
    message = {
      title: '⚠️ Text not delivered',
      body: truncate(`To ${who ?? to}: ${reason}`, 200),
      emails: sender ? [sender] : null,
      audience: 'admins',
      target: sanitizeTarget({
        type: 'sms_thread',
        customerId: record.customer_id,
        leadId: record.lead_id,
        contactId: record.contact_id,
        phone: to,
        name: who ?? undefined,
      }) ?? undefined,
      pref: sender ? 'texts' : undefined,
      dedupe: rid ? `sms_failed:${rid}` : undefined,
      source: src,
    };
  }

  // Stripe, as it lands on the customer (2026-11-08): a card saved, a payment problem.
  if (!message && table === 'customers' && op === 'UPDATE' && record) {
    const name = typeof record.name === 'string' && record.name ? record.name : 'A customer';
    const cardSaved = !oldRecord?.card_on_file_at && record.card_on_file_at;
    const emails = await adminsAndReps(rid ? `jobs?customer_id=eq.${rid}&select=sales_rep_email` : null);
    if (cardSaved) {
      const card = [record.card_brand, record.card_last4 ? `•${record.card_last4}` : null].filter(Boolean).join(' ');
      message = {
        title: '💳 Card saved',
        body: truncate(`${name}${card ? ` · ${card}` : ''}`, 200),
        emails,
        audience: 'admins',
        target: rid ? { type: 'customer', customerId: rid } : undefined,
        dedupe: rid ? `card:${rid}:${String(record.card_on_file_at)}` : undefined,
        source: src,
      };
    } else if (record.payment_issue) {
      message = {
        title: '⚠️ Payment problem',
        body: truncate(`${name}: ${String(record.payment_issue)}`, 200),
        emails,
        audience: 'admins',
        target: rid ? { type: 'customer', customerId: rid } : undefined,
        dedupe: rid ? `payissue:${rid}:${String(record.payment_issue_at ?? record.payment_issue)}` : undefined,
        source: src,
      };
    }
  }

  // A service visit paid (2026-11-08).
  if (!message && table === 'jobs' && op === 'UPDATE' && record) {
    const who = await recordName(record.customer_id, null, null);
    const reps = typeof record.sales_rep_email === 'string' && record.sales_rep_email ? [lower(record.sales_rep_email)] : [];
    const emails = Array.from(new Set([...(await adminEmails()), ...reps]));
    message = {
      title: '✅ Service plan paid',
      body: truncate(`${who ?? (typeof record.name === 'string' ? record.name : 'A customer')} — the plan charge went through.`, 200),
      emails,
      audience: 'admins',
      target:
        typeof record.customer_id === 'string'
          ? { type: 'customer', customerId: record.customer_id }
          : jobTarget(record.id),
      dedupe: rid ? `paid:${rid}` : undefined,
      source: src,
    };
  }

  if (!message) {
    return json(200, {
      sent: 0,
      logged: logged ?? undefined,
      skipped: 'nothing to push for this payload',
    });
  }

  const result = await deliver(message);
  return json(200, { ...result, logged: logged ?? undefined });
});

// ---------------------------------------------------------------------------
// Recipients, the Alerts row, the push
// ---------------------------------------------------------------------------

function oldRecordOrRecord(
  record: Record<string, unknown> | undefined,
  oldRecord: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  // notify_webhook sends the OLD row as `record` for a DELETE.
  return record ?? oldRecord;
}

/** Owner + operators of this company, real accounts only, lowercased. */
async function adminEmails(): Promise<string[]> {
  const rows = await rest(`employees?company=eq.${COMPANY}&role=in.(owner,operator)&is_test=eq.false&select=email`);
  return (rows ?? []).map((r) => String(r.email ?? '').toLowerCase()).filter(Boolean);
}

/** Every real employee of this company, lowercased. */
async function everyoneEmails(): Promise<string[]> {
  const rows = await rest(`employees?company=eq.${COMPANY}&is_test=eq.false&select=email`);
  return (rows ?? []).map((r) => String(r.email ?? '').toLowerCase()).filter(Boolean);
}

/** Admins plus the sales reps found by `repQuery` (rows with sales_rep_email). */
async function adminsAndReps(repQuery: string | null): Promise<string[]> {
  const admins = await adminEmails();
  const reps = repQuery ? await rest(repQuery) : null;
  const repEmails = (reps ?? []).map((r) => String(r.sales_rep_email ?? '').toLowerCase()).filter(Boolean);
  return Array.from(new Set([...admins, ...repEmails]));
}

/** A person's name from the CRM, for push bodies. */
async function recordName(customerId: unknown, leadId: unknown, contactId: unknown): Promise<string | null> {
  const pick = async (path: string) => {
    const rows = await rest(path);
    const n = (rows?.[0] as { name?: string } | undefined)?.name;
    return typeof n === 'string' && n.trim() ? n.trim() : null;
  };
  if (typeof customerId === 'string' && UUID_RE.test(customerId)) return pick(`customers?id=eq.${customerId}&select=name&limit=1`);
  if (typeof leadId === 'string' && UUID_RE.test(leadId)) return pick(`leads?id=eq.${leadId}&select=name&limit=1`);
  if (typeof contactId === 'string' && UUID_RE.test(contactId)) return pick(`contacts?id=eq.${contactId}&select=name&limit=1`);
  return null;
}

function quoteList(emails: string[]): string {
  return emails.map((e) => `"${e.replaceAll('"', '').replaceAll(',', '')}"`).join(',');
}

/** Unread Alerts for one person (the app icon badge). */
async function unreadCount(email: string): Promise<number | undefined> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return undefined;
  try {
    const res = await fetch(
      `${url}/rest/v1/notifications?recipient_email=eq.${encodeURIComponent(email)}&read_at=is.null&select=id`,
      { method: 'HEAD', headers: { apikey: key, authorization: `Bearer ${key}`, prefer: 'count=exact' } },
    );
    const range = res.headers.get('content-range'); // "0-4/5" or "*/0"
    const total = range ? Number(range.split('/')[1]) : NaN;
    return Number.isFinite(total) ? total : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the Alerts rows; return the recipients whose row is NEW (push only to them). */
async function recordAlerts(message: OutboundMessage, emails: string[]): Promise<string[] | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return null;
  const rows = emails.map((email) => ({
    company: COMPANY,
    recipient_email: email,
    title: message.title,
    body: message.body,
    target: message.target ?? null,
    source: message.source ?? null,
    dedupe_key: message.dedupe ?? null,
  }));
  try {
    const res = await fetch(`${url}/rest/v1/notifications?on_conflict=recipient_email,dedupe_key&select=recipient_email`, {
      method: 'POST',
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        prefer: 'return=representation,resolution=ignore-duplicates',
      },
      body: JSON.stringify(rows),
    });
    if (!res.ok) {
      console.error('notify: alerts insert failed', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const inserted = (await res.json()) as { recipient_email: string }[];
    return inserted.map((r) => r.recipient_email);
  } catch (e) {
    console.error('notify: alerts insert threw', e instanceof Error ? e.message : String(e));
    return null;
  }
}

interface Ticket {
  status?: 'ok' | 'error';
  message?: string;
  details?: { error?: string };
}

/**
 * Resolve recipients, apply their switches, keep the Alerts rows, push.
 * Every call logs ONE line (2026-11-08: notify logged nothing, so a push
 * could only be traced from the phone's diagnostics).
 */
async function deliver(message: OutboundMessage): Promise<Record<string, unknown>> {
  // Recipients, lowercased (2026-11-08): push_tokens are saved lowercase and
  // matched exactly, so a mixed-case employees / job_assignments email
  // reached no device at all.
  let emails: string[];
  if (message.emails) emails = Array.from(new Set(message.emails.map((e) => e.toLowerCase().trim()).filter(Boolean)));
  else if (message.audience === 'all') emails = await everyoneEmails();
  else emails = await adminEmails();

  // The recipients' own switches (Settings → Notifications). Admin-audience
  // pushes (no explicit list) ignore them, as before.
  if (message.pref && message.emails && emails.length) {
    const column = `notify_${message.pref}`;
    const off = await rest(`staff_profiles?company=eq.${COMPANY}&${column}=eq.false&select=email`);
    const muted = new Set((off ?? []).map((r) => String(r.email).toLowerCase()));
    emails = emails.filter((e) => !muted.has(e));
  }
  if (emails.length === 0) {
    console.log(JSON.stringify({ notify: 'skipped', reason: 'no recipients', source: message.source, title: message.title }));
    return { sent: 0, skipped: 'no recipients (or all turned it off)' };
  }

  // The Alerts list. With a dedupe key, only NEW rows are pushed.
  const fresh = await recordAlerts(message, emails);
  const pushTo = fresh ?? (message.dedupe ? [] : emails);
  if (fresh === null && message.dedupe) {
    // Could not record — rather than risk a repeat on every retry, still push once.
    pushTo.push(...emails);
  }
  if (pushTo.length === 0) {
    console.log(JSON.stringify({ notify: 'duplicate', dedupe: message.dedupe, source: message.source }));
    return { sent: 0, skipped: 'already sent' };
  }

  const tokens = await rest(`push_tokens?select=token,email&email=in.(${quoteList(pushTo)})`);
  if (!tokens) return { sent: 0, error: 'could not read push_tokens' };
  const badges = new Map<string, number | undefined>();
  for (const email of pushTo) badges.set(email, await unreadCount(email));

  const messages: PushMessage[] = tokens.map((row) => {
    const badge = badges.get(String(row.email).toLowerCase());
    return {
      to: String(row.token),
      title: message.title,
      body: message.body,
      sound: 'default',
      priority: 'high',
      ...(message.target ? { data: message.target } : {}),
      ...(typeof badge === 'number' ? { badge } : {}),
    };
  });

  // Expo accepts up to 100 messages per request. Read the TICKETS: a
  // DeviceNotRegistered token is dead (app deleted, sign-out that never
  // reached us) and is removed; other errors are logged. One retry on 429/5xx.
  let sent = 0;
  const errors: string[] = [];
  const dead: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(EXPO_PUSH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(batch),
        });
        if ((res.status === 429 || res.status >= 500) && attempt === 0) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        if (!res.ok) {
          errors.push(`expo ${res.status}`);
          break;
        }
        const out = (await res.json().catch(() => null)) as { data?: Ticket[] } | null;
        const tickets = out?.data ?? [];
        tickets.forEach((t, idx) => {
          if (t.status === 'ok') sent += 1;
          else {
            const code = t.details?.error ?? t.message ?? 'error';
            errors.push(code);
            if (t.details?.error === 'DeviceNotRegistered') dead.push(batch[idx].to);
          }
        });
        if (tickets.length === 0) sent += batch.length;
        break;
      } catch (e) {
        if (attempt === 0) continue;
        errors.push(e instanceof Error ? e.message : 'push failed');
      }
    }
  }
  if (dead.length) {
    const url = Deno.env.get('SUPABASE_URL');
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (url && key) {
      await fetch(`${url}/rest/v1/push_tokens?token=in.(${dead.map((t) => `"${t}"`).join(',')})`, {
        method: 'DELETE',
        headers: { apikey: key, authorization: `Bearer ${key}` },
      }).catch(() => {});
    }
  }

  console.log(
    JSON.stringify({
      notify: 'sent',
      source: message.source ?? null,
      title: message.title,
      target: message.target?.type ?? null,
      recipients: pushTo.length,
      devices: messages.length,
      sent,
      errors: errors.length ? errors : undefined,
      removedTokens: dead.length || undefined,
    }),
  );
  return {
    sent,
    recipients: pushTo.length,
    errors: errors.length ? errors : undefined,
    // Echoed so a test can see what went out without a device: never tokens.
    target: message.target ?? null,
  };
}

// ---------------------------------------------------------------------------
// Reminders (cron: notify-reminders, every 5 minutes)
// ---------------------------------------------------------------------------

const TZ = 'America/Chicago';

function centralParts(d: Date): { day: string; hh: number; mm: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hh: Number(get('hour')), mm: Number(get('minute')) };
}

/** Today's date in Kansas City. */
function centralToday(): string {
  return centralParts(new Date()).day;
}

/** A Central wall-clock time → the real instant (handles CST / CDT). */
function centralToUtc(day: string, hhmm: string): Date {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  for (const offset of [5, 6]) {
    const guess = new Date(Date.UTC(y, m - 1, d, (h || 0) + offset, mi || 0));
    const p = centralParts(guess);
    if (p.day === day && p.hh === (h || 0) && p.mm === (mi || 0)) return guess;
  }
  return new Date(Date.UTC(y, m - 1, d, (h || 0) + 6, mi || 0));
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n, 12));
  return t.toISOString().slice(0, 10);
}

function clockLabel(hhmm: string | null): string {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

async function runReminders(): Promise<Record<string, unknown>> {
  const now = new Date();
  const results: Record<string, unknown>[] = [];

  // Tasks that came due in the last hour, not done, with an owner.
  const since = new Date(now.getTime() - 60 * 60_000).toISOString();
  const tasks = (await rest(
    `tasks?company=eq.${COMPANY}&done_at=is.null&assigned_to=not.is.null&due_at=lte.${encodeURIComponent(now.toISOString())}&due_at=gte.${encodeURIComponent(since)}&select=id,title,due_at,assigned_to,lead_id,customer_id`,
  )) ?? [];
  for (const t of tasks) {
    const target: Target = { type: 'task', taskId: String(t.id) };
    if (typeof t.lead_id === 'string') target.leadId = t.lead_id;
    if (typeof t.customer_id === 'string') target.customerId = t.customer_id;
    results.push(
      await deliver({
        title: '⏰ Task due',
        body: truncate(String(t.title ?? 'A task'), 200),
        emails: [String(t.assigned_to).toLowerCase()],
        audience: 'admins',
        target,
        pref: 'tasks',
        dedupe: `task_due:${t.id}:${t.due_at}`,
        source: 'reminder:task',
      }),
    );
  }

  // Appointments: 24 h and 1 h ahead (Central time; no start time = 8 AM).
  const today = centralToday();
  const appts = (await rest(
    `lead_appointments?company=eq.${COMPANY}&assigned_to=not.is.null&appt_date=gte.${today}&appt_date=lte.${addDays(today, 2)}&select=id,lead_id,kind,appt_date,start_time,outcome,assigned_to`,
  )) ?? [];
  const leadIds = Array.from(new Set(appts.map((a) => a.lead_id).filter((v): v is string => typeof v === 'string')));
  const names = new Map<string, string>();
  if (leadIds.length) {
    const leads = await rest(`leads?id=in.(${leadIds.join(',')})&select=id,name`);
    for (const l of leads ?? []) names.set(String(l.id), String(l.name ?? ''));
  }
  for (const a of appts) {
    if (a.outcome) continue; // canceled, done, no-show: nothing to remind
    const time = typeof a.start_time === 'string' ? a.start_time.slice(0, 5) : null;
    const start = centralToUtc(String(a.appt_date), time ?? '08:00');
    const minutes = (start.getTime() - now.getTime()) / 60_000;
    if (minutes <= 0) continue;
    let which: '1h' | '24h' | null = null;
    if (minutes <= 65) which = '1h';
    else if (minutes <= 24 * 60 + 5) which = '24h';
    if (!which) continue;
    const kind = String(a.kind ?? 'appointment').replace('_', ' ');
    const lead = names.get(String(a.lead_id)) || 'a lead';
    const dayWord = a.appt_date === today ? 'today' : a.appt_date === addDays(today, 1) ? 'tomorrow' : String(a.appt_date);
    const at = time ? clockLabel(time) : 'time TBD';
    results.push(
      await deliver({
        title: which === '1h' ? `📅 ${kind[0].toUpperCase()}${kind.slice(1)} at ${at}` : `📅 ${kind[0].toUpperCase()}${kind.slice(1)} ${dayWord}`,
        body: truncate(`${kind} with ${lead} · ${dayWord} ${at}`, 200),
        emails: [String(a.assigned_to).toLowerCase()],
        audience: 'admins',
        target: sanitizeTarget({ type: 'appointment', appointmentId: a.id, leadId: a.lead_id, day: a.appt_date }) ?? undefined,
        pref: 'schedule',
        dedupe: `appt_${which}:${a.id}:${a.appt_date}:${time ?? ''}`,
        source: `reminder:appointment_${which}`,
      }),
    );
  }

  return { reminders: results.length, tasks: tasks.length, appointments: appts.length };
}
