// Supabase Edge Function: extract-materials — pull {name, qty} line items
// out of a materials PDF stored in the contracts bucket. Heuristic text
// parsing (no pricing); the app shows results for review before saving.
//
// Deployed with "Verify JWT" ON: callers must be signed in (the app's
// supabase.functions.invoke passes the session token), and the function
// additionally requires the caller to be a company admin.
//
// POST { storagePath: "<jobId>/<file>.pdf" }  →  { items: [{name, qty}] }

import { extractText, getDocumentProxy } from 'npm:unpdf';

function json(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Lines that are headers/totals/addresses, not line items. */
const JUNK_LINE =
  /total|subtotal|tax|amount|balance|invoice|estimate|quote|page \d|ship\s?to|bill\s?to|p\.?o\.?\s?box|phone|email|www\.|https?:|terms|signature|date[:\s]|thank you/i;

const UNIT_WORDS = '(?:EA|EACH|PCS?|PC|UNITS?|CT|BOX(?:ES)?|SETS?|KITS?|FT|LF)';

/** Parse plausible {name, qty} line items out of extracted PDF text. */
function parseItems(text: string): { name: string; qty: number }[] {
  const items: { name: string; qty: number }[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    // Collapse whitespace and strip prices — pricing is explicitly ignored.
    const line = rawLine
      .replace(/\$\s?[\d,]+(?:\.\d+)?/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (line.length < 4 || JUNK_LINE.test(line)) continue;

    let name = '';
    let qty = 0;

    // "IronRidge XR-100 rail 168in   12 EA"  (trailing quantity)
    const trailing = line.match(
      new RegExp(`^(.*?[A-Za-z]{3,}.*?)\\s+(\\d{1,4}(?:\\.\\d+)?)\\s*${UNIT_WORDS}?\\.?$`, 'i'),
    );
    // "12 x IronRidge XR-100 rail 168in"  (leading quantity)
    const leading = line.match(/^(\d{1,4}(?:\.\d+)?)\s+(?:[xX]\s+)?(.*[A-Za-z]{3,}.*)$/);

    if (trailing) {
      name = trailing[1].trim();
      qty = Number(trailing[2]);
    } else if (leading) {
      qty = Number(leading[1]);
      name = leading[2].trim();
    } else {
      continue;
    }

    // Sanity: real quantities, real names (with letters, not just codes).
    if (!Number.isFinite(qty) || qty <= 0 || qty > 5000) continue;
    name = name.replace(/^[-–—•*.\s]+|[-–—•*.\s]+$/g, '');
    if (name.length < 3 || !/[A-Za-z]{3}/.test(name)) continue;

    const key = `${name.toLowerCase()}|${qty}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name: name.slice(0, 200), qty });
    if (items.length >= 100) break;
  }
  return items;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json(500, { error: 'missing env' });

  // Caller must be a signed-in company admin.
  const authHeader = req.headers.get('authorization') ?? '';
  const userRes = await fetch(`${url}/auth/v1/user`, {
    headers: { apikey: serviceKey, authorization: authHeader },
  });
  if (!userRes.ok) return json(401, { error: 'not signed in' });
  const user = (await userRes.json()) as { email?: string };
  if (!user.email) return json(401, { error: 'not signed in' });
  const adminRes = await fetch(
    `${url}/rest/v1/employees?email=eq.${encodeURIComponent(user.email)}&role=in.(owner,operator)&select=email`,
    { headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` } },
  );
  const admins = adminRes.ok ? ((await adminRes.json()) as unknown[]) : [];
  if (admins.length === 0) return json(403, { error: 'admins only' });

  let body: { storagePath?: string };
  try {
    body = (await req.json()) as { storagePath?: string };
  } catch {
    return json(400, { error: 'invalid JSON' });
  }
  const storagePath = body.storagePath;
  if (!storagePath || typeof storagePath !== 'string' || storagePath.includes('..')) {
    return json(400, { error: 'storagePath required' });
  }

  // Download the PDF from the contracts bucket with the service role.
  const fileRes = await fetch(`${url}/storage/v1/object/contracts/${storagePath}`, {
    headers: { apikey: serviceKey, authorization: `Bearer ${serviceKey}` },
  });
  if (!fileRes.ok) return json(404, { error: `could not read the PDF (${fileRes.status})` });
  const buffer = new Uint8Array(await fileRes.arrayBuffer());

  try {
    const pdf = await getDocumentProxy(buffer);
    const { text } = await extractText(pdf, { mergePages: true });
    const items = parseItems(typeof text === 'string' ? text : text.join('\n'));
    return json(200, { items });
  } catch (e) {
    return json(422, {
      error: e instanceof Error ? e.message : 'could not parse the PDF',
    });
  }
});
