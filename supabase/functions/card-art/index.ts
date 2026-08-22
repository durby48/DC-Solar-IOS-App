/**
 * card-art — (re)generate the artwork for one trading card with Gemini.
 *
 * The 61 cards in the original deck were drawn by `tools/generate_art.py` in
 * the dc-solar-tcg repo. That script is a laptop tool: it reads cards.json and
 * writes PNGs to disk. Once the deck lives in Postgres and the art lives in the
 * private `cards` bucket, adding a card in the app has to be able to draw it —
 * so the same prompt construction is reimplemented here, deliberately
 * verbatim, so a card generated in 2027 still looks like it belongs to the set.
 *
 * THE PROMPT IS THREE PARTS AND ALL THREE MATTER:
 *   STYLE preamble  — what makes every card look like the same product;
 *   the card's own `art_prompt` (+ a per-type framing note);
 *   the rarity burst — the energy treatment whose COLOUR encodes the rarity.
 * Editing one card's art_prompt is expected. Editing the preamble or the burst
 * makes that card stop matching the other sixty.
 *
 * HOUSE-ART CARDS. When the card is linked to a real job that already has
 * ready property artwork, that cartoon is passed in as an inline image and the
 * prompt changes to "keep this house exactly, add the energy pass" — the same
 * image-to-image shape property-art uses. That is why job cards look like the
 * actual roof and not a generic house.
 *
 * Auth: verify_jwt ON plus a server-side admin re-check. Every call costs real
 * money (~4¢), so existing art is returned as-is unless `force: true`.
 *
 * Secrets: GEMINI_API_KEY (AI Studio — a Maps key will not work; see the
 * property-art header for that whole story).
 *
 * POST { cardId, force? } → { ok: true, artPath, cached?, version? }
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const GEMINI_MODEL = 'gemini-3.1-flash-image';
/** Cards are portrait. The print template crops a 1.63:1 window out of this. */
const IMAGE_ASPECT_RATIO = '3:4';
const BUCKET = 'cards';

// --- copied verbatim from dc-solar-tcg/tools/generate_art.py ---------------

const STYLE =
  'Premium collectible trading card illustration. Richly painted, bold ' +
  'saturated colors, dramatic lighting, crisp details, dynamic low-angle ' +
  'composition. The confident energy of 1990s holographic sports cards ' +
  'fused with modern fantasy TCG card art. Warm Kansas-Missouri light, ' +
  'big midwestern skies. ABSOLUTELY NO text, letters, numbers, logos, ' +
  'watermarks, borders, or frames in the image — pure full-bleed artwork ' +
  'only. Portrait composition. Scene: ';

const TYPE_NOTES: Record<string, string> = {
  job: ' Emphasize the location and the scale of the work; make the rooftop or site the hero.',
  crew: ' Character portrait, waist-up or full body, larger than life, strong silhouette, hero framing.',
  tool: ' Dramatic object portrait, the item presented like a legendary artifact.',
  event: ' Dynamic scene mid-action, weather and motion, cinematic moment.',
  special: ' Mythic, glowing, one-of-a-kind aura.',
};

const RARITY_COLOR: Record<string, string> = {
  common: 'silver-white and polished-steel',
  uncommon: 'vivid emerald-green',
  rare: 'brilliant sapphire-blue',
  legendary: 'blazing golden-orange',
  secret: 'electric violet-magenta',
};

function burstNote(rarity: string | null): string {
  const color = RARITY_COLOR[rarity ?? ''] ?? 'radiant multicolor';
  return (
    ` Dynamic ${color} energy effects burst and dash through the artwork like the interior ` +
    `artwork of a modern Pokemon ex trading card: glowing diagonal slashes, radiant burst rays, speed lines, ` +
    `crackling arcs and sparkling particle trails in ${color} tones sweeping across and ` +
    'around the subject, explosive kinetic composition, the energy clearly interacting ' +
    'with the scene. Render ONLY the full-bleed artwork itself — never draw the trading card ' +
    'as a physical object: no card borders, rounded card corners, tables, or backgrounds ' +
    'behind a card.'
  );
}

// ---------------------------------------------------------------------------

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

/** Uint8Array → base64 without blowing the stack on large images. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const CARD_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;

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

    // --- caller must be a company admin ------------------------------------
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!jwt) return fail(401, 'unauthorized', 'Missing Authorization header.');
    const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
    const email = userData?.user?.email?.toLowerCase();
    if (userErr || !email) return fail(401, 'unauthorized', 'Not signed in.');
    const { data: employee } = await admin
      .from('employees')
      .select('role')
      .eq('email', email)
      .maybeSingle();
    const role = (employee as { role?: string } | null)?.role;
    if (role !== 'owner' && role !== 'operator') return fail(403, 'forbidden', 'Admins only.');

    // --- input --------------------------------------------------------------
    let payload: { cardId?: string; force?: boolean };
    try {
      payload = (await req.json()) as { cardId?: string; force?: boolean };
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }
    const cardId = payload.cardId?.trim().toLowerCase();
    if (!cardId || !CARD_ID_RE.test(cardId)) {
      return fail(400, 'bad_request', 'cardId is required and looks like "job-26019".');
    }

    const { data: cardRow } = await admin
      .from('cards')
      .select('id, company, card_type, title, rarity, art_prompt, art_path, job_id, version')
      .eq('id', cardId)
      .maybeSingle();
    const card = cardRow as {
      id: string;
      company: string;
      card_type: string;
      title: string;
      rarity: string | null;
      art_prompt: string | null;
      art_path: string | null;
      job_id: string | null;
      version: number | null;
    } | null;
    if (!card) return fail(404, 'not_found', `There is no card called "${cardId}".`);

    // Art already exists and nobody asked for a redraw — never re-bill on a
    // screen that merely opened.
    if (card.art_path && !payload.force) {
      return ok({ artPath: card.art_path, cached: true, version: card.version ?? 1 });
    }

    if (!card.art_prompt?.trim()) {
      return fail(
        400,
        'bad_request',
        `${card.title} has no art prompt. Write one on the card first — the prompt is what the artwork is drawn from.`,
      );
    }

    const geminiKey = Deno.env.get('GEMINI_API_KEY');
    if (!geminiKey) {
      return fail(
        503,
        'not_configured',
        'Card art needs a GEMINI_API_KEY secret. Create one at aistudio.google.com/app/apikey ' +
          '— a Maps key will not work for Gemini, Google keeps the two separate.',
      );
    }

    // --- optional house art (job cards linked to a real job) -----------------
    let houseBytes: Uint8Array | null = null;
    let houseMime = 'image/png';
    if (card.job_id) {
      const { data: artRow } = await admin
        .from('job_artwork')
        .select('status, art_path')
        .eq('job_id', card.job_id)
        .maybeSingle();
      const artwork = artRow as { status: string; art_path: string | null } | null;
      if (artwork?.status === 'ready' && artwork.art_path) {
        const { data: file } = await admin.storage.from('property-art').download(artwork.art_path);
        if (file) {
          houseBytes = new Uint8Array(await file.arrayBuffer());
          houseMime = file.type || 'image/png';
        }
      }
    }

    // --- prompt --------------------------------------------------------------
    const burst = burstNote(card.rarity);
    let prompt: string;
    if (houseBytes) {
      prompt =
        'Use the attached flat cartoon house illustration as the exact base scene: keep the ' +
        'house, landscaping, layout, colors and clean flat vector style completely unchanged ' +
        'and clearly recognizable. Do not repaint or restyle the house.' +
        burst +
        ' Absolutely no text, letters, numbers, logos, watermarks, borders or frames.';
    } else {
      prompt =
        STYLE + card.art_prompt.trim() + (TYPE_NOTES[card.card_type] ?? '') + burst;
    }

    const parts: Record<string, unknown>[] = [];
    if (houseBytes) {
      parts.push({ inline_data: { mime_type: houseMime, data: toBase64(houseBytes) } });
    }
    parts.push({ text: prompt });

    // --- Gemini --------------------------------------------------------------
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts }],
          generationConfig: { imageConfig: { aspectRatio: IMAGE_ASPECT_RATIO } },
        }),
      },
    );
    if (!geminiRes.ok) {
      const detail = (await geminiRes.text()).slice(0, 300);
      return fail(502, 'gemini_error', `Gemini rejected the request (${geminiRes.status}): ${detail}`);
    }

    const gemini = (await geminiRes.json()) as {
      candidates?: {
        content?: {
          parts?: {
            inline_data?: { data?: string; mime_type?: string };
            inlineData?: { data?: string; mimeType?: string };
          }[];
        };
      }[];
    };
    let artB64: string | undefined;
    let artMime = 'image/png';
    for (const part of gemini.candidates?.[0]?.content?.parts ?? []) {
      const inline = part.inline_data ?? part.inlineData;
      const data = (inline as { data?: string } | undefined)?.data;
      if (data) {
        artB64 = data;
        artMime =
          (inline as { mime_type?: string }).mime_type ??
          (inline as { mimeType?: string }).mimeType ??
          'image/png';
        break;
      }
    }
    if (!artB64) return fail(502, 'gemini_error', `Gemini returned no image for ${card.title}.`);

    // --- store ---------------------------------------------------------------
    // The imported deck is WebP because `scripts/tcg/import.mjs` runs `sharp`
    // on a laptop. Deno Deploy has no image codec, so a freshly generated card
    // is stored in whatever Gemini returned (PNG today) rather than pretending
    // to be WebP. The client reads cards.art_path — it never guesses the
    // extension — so both live happily side by side.
    const ext = artMime.includes('webp') ? 'webp' : artMime.includes('jpeg') ? 'jpg' : 'png';
    const artPath = `${card.id}.${ext}`;
    const { error: upErr } = await admin.storage
      .from(BUCKET)
      .upload(artPath, fromBase64(artB64), { contentType: artMime, upsert: true });
    if (upErr) return fail(500, 'upload_failed', `Could not save the artwork: ${upErr.message}`);

    const version = (card.version ?? 1) + 1;
    const { error: updateErr } = await admin
      .from('cards')
      .update({ art_path: artPath, version })
      .eq('id', card.id);
    if (updateErr) {
      return fail(500, 'server_error', `Artwork saved but the card did not update: ${updateErr.message}`);
    }

    return ok({ artPath, version, cached: false });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Card art generation failed.');
  }
});
