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
//
// audience: "admins" (default — owner/operator only; bank alerts are
// admin business) or "all" (whole crew).

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const COMPANY = 'dc-solar';

interface PushMessage {
  to: string;
  title: string;
  body: string;
  sound: 'default';
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
    job_id: job?.id ?? null,
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

/** Normalize any accepted body shape into {title, body, emails?, audience}. */
function normalize(payload: Record<string, unknown>): {
  title: string;
  body: string;
  emails: string[] | null;
  audience: 'admins' | 'all';
} | null {
  // Database webhook shape (finance_entries INSERT).
  if (payload.type === 'INSERT' && payload.record && typeof payload.record === 'object') {
    const record = payload.record as Record<string, unknown>;
    if (record.type !== 'payment') return null; // only payments push
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
    };
  }

  // Gmail Apps Script shape.
  if (typeof payload.subject === 'string' && typeof payload.from === 'string') {
    const subject = truncate(payload.subject, 100);
    const snippet = typeof payload.snippet === 'string' ? truncate(payload.snippet, 140) : '';
    const emoji = MONEY_WORDS.test(`${payload.subject} ${payload.snippet ?? ''}`) ? '💰' : '📬';
    return {
      title: `${emoji} ${subject}`,
      body: snippet ? `${fromName(payload.from)} — ${snippet}` : fromName(payload.from),
      emails: null,
      audience: 'admins',
    };
  }

  // Direct shape.
  if (typeof payload.title === 'string' && typeof payload.body === 'string') {
    const emails =
      Array.isArray(payload.emails) && payload.emails.every((e) => typeof e === 'string')
        ? (payload.emails as string[])
        : null;
    return {
      title: truncate(payload.title, 100),
      body: truncate(payload.body, 200),
      emails,
      audience: payload.audience === 'all' ? 'all' : 'admins',
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

  if (!message && table === 'job_assignments' && record?.email) {
    const label = await jobLabel(record.job_id);
    if (op === 'INSERT') {
      message = {
        title: '🔧 New job assignment',
        body: truncate(`You've been assigned to ${label}.`, 200),
        emails: [String(record.email)],
        audience: 'admins',
      };
    } else if (op === 'DELETE') {
      message = {
        title: '🔧 Removed from job',
        body: truncate(`You've been taken off ${label}.`, 200),
        emails: [String(record.email)],
        audience: 'admins',
      };
    }
  }

  if (!message && table === 'job_schedule_dates' && record?.job_id) {
    // Only ping when the date or start time actually changed.
    const changed =
      op !== 'UPDATE' ||
      record.work_date !== oldRecord?.work_date ||
      record.start_time !== oldRecord?.start_time;
    if (changed && (op === 'INSERT' || op === 'UPDATE' || op === 'DELETE')) {
      const emails = await assignedEmails(record.job_id);
      if (emails.length === 0) {
        return json(200, { sent: 0, skipped: 'no crew assigned to this job' });
      }
      const label = await jobLabel(record.job_id);
      const when = `${prettyDate(record.work_date)}${prettyTime(record.start_time)}`;
      const body =
        op === 'INSERT'
          ? `${label} scheduled for ${when}.`
          : op === 'UPDATE'
            ? `${label} moved to ${when}.`
            : `${label}: the ${prettyDate(record.work_date)} work day was removed.`;
      message = {
        title: op === 'DELETE' ? '📅 Schedule change' : '📅 Job scheduled',
        body: truncate(body, 200),
        emails,
        audience: 'admins',
      };
    }
  }

  if (!message) {
    return json(200, {
      sent: 0,
      logged: logged ?? undefined,
      skipped: 'nothing to push for this payload',
    });
  }

  // Resolve recipient emails: explicit list, or admins, or everyone.
  let emails = message.emails;
  if (!emails && message.audience === 'admins') {
    const admins = await rest('employees?role=in.(owner,operator)&select=email');
    if (!admins) return json(500, { error: 'could not read employees' });
    emails = admins.map((r) => String(r.email)).filter(Boolean);
  }

  // Tokens for those emails (or every registered device for audience=all).
  const filter = emails?.length
    ? `&email=in.(${emails.map((e) => `"${e.replaceAll('"', '')}"`).join(',')})`
    : '';
  const tokens = await rest(`push_tokens?company=eq.${COMPANY}&select=token${filter}`);
  if (!tokens) return json(500, { error: 'could not read push_tokens' });
  if (tokens.length === 0) return json(200, { sent: 0, skipped: 'no registered devices' });

  const messages: PushMessage[] = tokens.map((row) => ({
    to: String(row.token),
    title: message.title,
    body: message.body,
    sound: 'default',
  }));

  // Expo accepts up to 100 messages per request.
  let sent = 0;
  const errors: string[] = [];
  for (let i = 0; i < messages.length; i += 100) {
    const batch = messages.slice(i, i + 100);
    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(batch),
      });
      if (res.ok) sent += batch.length;
      else errors.push(`expo ${res.status}`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : 'push failed');
    }
  }

  return json(200, {
    sent,
    logged: logged ?? undefined,
    errors: errors.length ? errors : undefined,
  });
});
