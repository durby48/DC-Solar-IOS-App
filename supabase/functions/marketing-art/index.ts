/**
 * marketing-art — draw one of DC Solar's marketing pictures with Gemini.
 *
 * Slots (2026-10-12): the sales call script's header picture and the Solar
 * Shield program — each carrying the real DC Solar logo (passed as a reference
 * image) and the Kansas City skyline — (a banner + one package per tier: Bronze, Silver, Gold) that
 * customers see on the brochure and reps see on Plans & prices.
 *
 * THE PROMPTS LIVE HERE, not in the app, so a redraw a year from now still
 * looks like the same campaign. `direction` adds a one-off note ("make the
 * roof darker") on top of the slot's prompt without replacing it.
 *
 * Each redraw saves a NEW file name in the public 'marketing-art' bucket and
 * points marketing_art.path at it (2026-10-12_marketing_art.sql), so nobody is
 * ever served a stale cached image. Old files stay (Stripe product images link
 * to them).
 *
 * Auth: verify_jwt ON. The caller is a company admin (owner/operator, or a
 * developer), or the service role (a session drawing the set from a PC — the
 * gateway has already verified the JWT's signature, so its role claim is real).
 * Every call costs real money (~4¢): an existing picture is returned as-is
 * unless `force: true`.
 *
 * Secrets: GEMINI_API_KEY (AI Studio — see property-art for why a Maps key
 * will not do).
 *
 * POST { key, force?, direction? } → { ok: true, path, cached? }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODEL = 'gemini-3.1-flash-image';
const BUCKET = 'marketing-art';

/** What every picture shares — the campaign look. */
const STYLE =
  'Polished modern marketing illustration for a local Kansas City solar service company. ' +
  'Clean semi-realistic digital painting with crisp edges and soft gradients, warm golden-hour light, ' +
  'big midwestern sky. Palette: warm sun orange (#F2A93B), deep navy (#1F2A33), clear sky blue, ' +
  'with white highlights. Trustworthy, premium and friendly — not cartoonish, not stock-photo bland. ';

/** The shared shield emblem, so the three tiers read as one product line. */
const SHIELD =
  'The hero object is a heraldic shield emblem with a stylised rising sun and a grid of solar-panel cells ' +
  'engraved across its face, a raised rim, and a small sun burst at the top. ';

/**
 * The real DC Solar logo rides along as a reference image (2026-10-12, Devon:
 * "include the logo and imagery of DC Solar"). It lives in this bucket at
 * LOGO_PATH (a copy of app/assets/images/app-icon.png — skyline over the
 * wordmark on cream). Gemini redraws it into the scene; eyeball every result,
 * a garbled logo is worse than none.
 */
const LOGO_PATH = 'brand/dc-solar-logo.png';
const LOGO =
  'The attached image is the DC Solar logo: a black Kansas City skyline silhouette above the wordmark ' +
  '"DC SOLAR" in heavy geometric capitals (the O is a solid black circle, the A has no crossbar). Wherever ' +
  'this prompt asks for the DC Solar logo, reproduce THAT logo faithfully and legibly — same skyline, same ' +
  'letterforms, black or white on a plain panel. Never invent a different logo or misspell it. ';
const SKYLINE =
  'The downtown Kansas City skyline (the same skyline as in the logo) is visible on the horizon. ';

const ONLY_TEXT = (allowed: string) =>
  ` The ONLY text in the whole image is ${allowed}. No other words, letters, numbers, logos or watermarks.`;

const TIER_PACKAGE = (metal: string, label: string, extras: string) =>
  STYLE +
  LOGO +
  SHIELD +
  `Show it as premium product packaging: the shield is cast in polished ${metal}, standing upright in front of ` +
  `a deep navy presentation box trimmed in ${metal}, on a clean light surface with a soft reflection. The DC ` +
  `Solar logo is printed in white, clearly and legibly, on the front of the box below the shield. Behind it, ` +
  `softly out of focus, a Kansas City home with solar panels on the roof. ${extras} ` +
  `Engraved on the shield in clean bold capitals, spelled exactly: "SOLAR SHIELD" on the top line and ` +
  `"${label}" on the line below. Check the spelling letter by letter.` +
  ONLY_TEXT(`"SOLAR SHIELD", "${label}" and the DC Solar logo`);

const SLOTS: Record<string, { prompt: string; aspect: string }> = {
  'script-hero': {
    aspect: '16:9',
    prompt:
      STYLE +
      LOGO +
      SKYLINE +
      'Scene: the morning after a hailstorm in a Kansas City suburb. Storm clouds are breaking up and golden ' +
      'sunlight is coming through. In the foreground a residential roof with a clean solar array; a DC Solar ' +
      'technician in a sun-orange work shirt and navy cap kneels beside the panels, checking them with a tablet. ' +
      'A few hailstones and leaves on the shingles. Below, in the driveway, a white DC Solar service van with ' +
      'the DC Solar logo large and legible on its side. Hopeful, reassuring mood — help has arrived.' +
      ONLY_TEXT('the DC Solar logo on the van'),
  },
  'shield-program': {
    aspect: '16:9',
    prompt:
      STYLE +
      LOGO +
      SHIELD +
      SKYLINE +
      'Three of these shields stand side by side on a deep navy display plinth, left to right: polished ' +
      'bronze, polished silver, polished gold — the gold one slightly larger and glowing warmly. The DC Solar ' +
      'logo is printed in white, large and legible, centred on the front face of the plinth. Behind them, a ' +
      'Kansas City neighbourhood with solar panels on the roofs under a clearing storm sky with sunshine ' +
      'breaking through.' +
      ONLY_TEXT('the DC Solar logo on the plinth'),
  },
  'shield-bronze': {
    aspect: '4:5',
    prompt: TIER_PACKAGE('bronze', 'BRONZE', 'Simple and solid — an entry-level but quality product.'),
  },
  'shield-silver': {
    aspect: '4:5',
    prompt: TIER_PACKAGE('silver', 'SILVER', 'A step up — a faint cool glow around the shield.'),
  },
  'shield-gold': {
    aspect: '4:5',
    prompt: TIER_PACKAGE(
      'gold',
      'GOLD',
      'The top tier — a warm radiant glow, subtle light rays and a few sparkles around the shield.',
    ),
  },
};

function ok(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ ok: true, ...body }), {
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function fail(status: number, code: string, error: string): Response {
  return new Response(JSON.stringify({ ok: false, code, error }), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

/** Uint8Array → base64 without blowing the stack on large images. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The role claim of a JWT the gateway has already verified (verify_jwt ON). */
function jwtRole(jwt: string): string | null {
  try {
    const payload = jwt.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
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

    // --- caller: company admin, or the service role ---------------------------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    let who = 'service role';
    if (jwtRole(jwt) !== 'service_role') {
      const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
      const email = userData?.user?.email?.toLowerCase();
      if (userErr || !email) return fail(401, 'unauthorized', 'Not signed in.');
      const { data: employee } = await admin
        .from('employees')
        .select('is_developer, role')
        .eq('email', email)
        .maybeSingle();
      const role = (employee as { is_developer?: boolean } | null)?.is_developer
        ? 'owner'
        : (employee as { role?: string } | null)?.role;
      if (role !== 'owner' && role !== 'operator') return fail(403, 'forbidden', 'Admins only.');
      who = email;
    }

    // --- input ------------------------------------------------------------------
    let payload: { key?: string; force?: boolean; direction?: string };
    try {
      payload = (await req.json()) as typeof payload;
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }
    const key = payload.key?.trim() ?? '';
    const slot = SLOTS[key];
    if (!slot) return fail(400, 'bad_request', `key must be one of: ${Object.keys(SLOTS).join(', ')}.`);

    const { data: existing } = await admin.from('marketing_art').select('path').eq('key', key).maybeSingle();
    const oldPath = (existing as { path?: string } | null)?.path ?? null;
    if (oldPath && !payload.force) return ok({ path: oldPath, cached: true });

    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) return fail(503, 'not_configured', 'Marketing art needs the GEMINI_API_KEY secret.');

    const direction = payload.direction?.trim().slice(0, 500);
    const prompt = direction ? `${slot.prompt} Additional direction: ${direction}` : slot.prompt;

    // --- the real logo, as a reference image ------------------------------------
    const parts: Record<string, unknown>[] = [];
    const { data: logo } = await admin.storage.from(BUCKET).download(LOGO_PATH);
    if (logo) {
      parts.push({ inline_data: { mime_type: logo.type || 'image/png', data: toBase64(new Uint8Array(await logo.arrayBuffer())) } });
    }
    parts.push({ text: prompt });

    // --- Gemini -----------------------------------------------------------------
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { imageConfig: { aspectRatio: slot.aspect } },
        }),
      },
    );
    if (!geminiRes.ok) {
      const detail = (await geminiRes.text()).slice(0, 300);
      return fail(502, 'gemini_error', `Gemini rejected the request (${geminiRes.status}): ${detail}`);
    }
    const gemini = (await geminiRes.json()) as {
      candidates?: { content?: { parts?: Record<string, unknown>[] } }[];
    };
    let artB64: string | undefined;
    let artMime = 'image/png';
    for (const part of gemini.candidates?.[0]?.content?.parts ?? []) {
      const inline = (part.inline_data ?? part.inlineData) as
        | { data?: string; mime_type?: string; mimeType?: string }
        | undefined;
      if (inline?.data) {
        artB64 = inline.data;
        artMime = inline.mime_type ?? inline.mimeType ?? 'image/png';
        break;
      }
    }
    if (!artB64) return fail(502, 'gemini_error', `Gemini returned no image for ${key}.`);

    // --- store ------------------------------------------------------------------
    const ext = artMime.includes('webp') ? 'webp' : artMime.includes('jpeg') ? 'jpg' : 'png';
    const path = `${key}-${Date.now()}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(path, fromBase64(artB64), { contentType: artMime, upsert: false, cacheControl: '31536000' });
    if (upErr) return fail(500, 'upload_failed', `Could not save the picture: ${upErr.message}`);

    const { error: rowErr } = await admin.from('marketing_art').upsert({
      key,
      path,
      prompt,
      updated_at: new Date().toISOString(),
      updated_by: who,
    });
    if (rowErr) return fail(500, 'server_error', `Picture saved but not recorded: ${rowErr.message}`);
    // Old files are KEPT: the Stripe products (Solar Shield tiers) link to them
    // as their images, and a deleted file would break that picture.

    return ok({ path, cached: false });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Drawing failed.');
  }
});
