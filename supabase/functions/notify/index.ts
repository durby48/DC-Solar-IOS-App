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
//   { from, subject, snippet }             email-triggered (Gmail Apps Script)
//   { type: "INSERT", record: {...} }      Supabase database webhooks:
//     - finance_entries payment inserts  → 💰 push to admins
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

  if (!message) return json(200, { sent: 0, skipped: 'nothing to push for this payload' });

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

  return json(200, { sent, errors: errors.length ? errors : undefined });
});
