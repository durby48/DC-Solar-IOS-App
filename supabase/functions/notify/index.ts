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
//   { type: "INSERT", record: {...} }      Supabase database webhook on
//                                          finance_entries (payment inserts)
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

  const message = normalize(payload);
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
