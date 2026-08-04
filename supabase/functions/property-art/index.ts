/**
 * property-art — turn a job's address into a cartoon picture of that property.
 *
 * Pipeline for one job:
 *   1. Read the job (address, job_number) with the service role.
 *   2. Ask Google Street View Static for a photo of that address.
 *      (Metadata endpoint first: it tells us whether coverage exists WITHOUT
 *      billing an image request.)
 *   3. Send that photo to Gemini image generation as an image-to-image edit
 *      with a "make this a clean cartoon illustration" prompt.
 *   4. Store the returned PNG in the private `property-art` bucket and upsert
 *      the job's row in `job_artwork`.
 *
 * A caller can skip step 2 by passing `photoPath` — the storage path of a
 * photo Devon took himself. That's the manual override.
 *
 * Auth: verify_jwt ON. The caller must be a signed-in admin; we re-check the
 * role server-side rather than trusting the client.
 *
 * Required secrets:
 *   GOOGLE_API_KEY  — one key with BOTH "Street View Static API" and
 *                     "Generative Language API" enabled.
 *
 * Costs, so nobody is surprised: Street View Static is ~$7/1000 images and a
 * Gemini image generation is a few cents. Art is generated ONCE per job and
 * cached in storage — re-opening the pipeline never re-bills.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const GEMINI_MODEL = 'gemini-2.5-flash-image';
const STREETVIEW_SIZE = '640x400';

const CARTOON_PROMPT = [
  'Redraw this house as a clean, friendly 2D cartoon illustration.',
  'Flat vector style with bold simple shapes, soft pastel colors, smooth',
  'outlines, a clear blue sky, green lawn and simple stylized trees.',
  'Keep the building recognizable: same rooflines, same number of storeys,',
  'same garage and window placement, same general proportions.',
  'No people, no cars, no text, no watermarks, no house numbers.',
  'Bright, cheerful, daytime lighting. Square-ish framing of the whole house.',
].join(' ');

interface Payload {
  jobId?: string;
  /** Optional: storage path (in job-photos or property-art) to use instead of Street View. */
  photoPath?: string;
  /** Optional: regenerate even when artwork already exists. */
  force?: boolean;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
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

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const googleKey = Deno.env.get('GOOGLE_API_KEY');
  if (!googleKey) {
    return json(
      {
        error:
          'Artwork is not set up yet. This needs a Google API key (with Street View ' +
          'Static API and Generative Language API enabled) saved as the GOOGLE_API_KEY ' +
          'secret on the property-art function. Until then, cards show the placeholder ' +
          'illustration.',
      },
      503,
    );
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  // --- caller must be a company admin -------------------------------------
  const authHeader = req.headers.get('Authorization') ?? '';
  const jwt = authHeader.replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: 'Not signed in' }, 401);

  const { data: employee } = await admin
    .from('employees')
    .select('role')
    .eq('email', email)
    .maybeSingle();
  const role = (employee as { role?: string } | null)?.role;
  if (role !== 'owner' && role !== 'operator') {
    return json({ error: 'Admins only' }, 403);
  }

  // --- input ---------------------------------------------------------------
  let payload: Payload;
  try {
    payload = (await req.json()) as Payload;
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const jobId = payload.jobId;
  if (!jobId) return json({ error: 'jobId is required' }, 400);

  const { data: job, error: jobErr } = await admin
    .from('jobs')
    .select('id, company, name, address, job_number')
    .eq('id', jobId)
    .maybeSingle();
  if (jobErr || !job) return json({ error: 'Job not found' }, 404);

  const jobRow = job as {
    id: string;
    company: string;
    name: string | null;
    address: string | null;
    job_number: string | null;
  };

  const sourceRef = payload.photoPath ?? jobRow.address ?? '';
  if (!sourceRef) {
    return json({ error: 'This job has no address and no photo was supplied.' }, 400);
  }

  // Skip work when we already have ready artwork from the same source.
  if (!payload.force) {
    const { data: existing } = await admin
      .from('job_artwork')
      .select('status, source_ref, art_path')
      .eq('job_id', jobId)
      .maybeSingle();
    const row = existing as
      | { status: string; source_ref: string | null; art_path: string | null }
      | null;
    if (row?.status === 'ready' && row.source_ref === sourceRef && row.art_path) {
      return json({ ok: true, cached: true, artPath: row.art_path });
    }
  }

  await admin.from('job_artwork').upsert(
    {
      job_id: jobId,
      company: jobRow.company,
      source: payload.photoPath ? 'photo' : 'streetview',
      source_ref: sourceRef,
      status: 'pending',
      error: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id' },
  );

  const fail = async (message: string, status = 502) => {
    await admin
      .from('job_artwork')
      .update({ status: 'failed', error: message, updated_at: new Date().toISOString() })
      .eq('job_id', jobId);
    return json({ error: message }, status);
  };

  try {
    // --- 1. get the source photo ------------------------------------------
    let sourceBytes: Uint8Array;
    let sourceMime = 'image/jpeg';

    if (payload.photoPath) {
      // Devon's own photo, already in storage.
      const bucket = payload.photoPath.startsWith('property-art/')
        ? 'property-art'
        : 'job-photos';
      const path = payload.photoPath.replace(/^property-art\//, '');
      const { data: file, error } = await admin.storage.from(bucket).download(path);
      if (error || !file) return await fail('Could not read the supplied photo.', 400);
      sourceBytes = new Uint8Array(await file.arrayBuffer());
      sourceMime = file.type || 'image/jpeg';
    } else {
      const address = jobRow.address!;
      // Metadata first — free, and tells us if there's coverage at all.
      const metaUrl =
        `https://maps.googleapis.com/maps/api/streetview/metadata` +
        `?location=${encodeURIComponent(address)}&key=${googleKey}`;
      const metaRes = await fetch(metaUrl);
      const meta = (await metaRes.json()) as { status?: string };
      if (meta.status !== 'OK') {
        return await fail(
          `Street View has no image for "${address}" (status ${meta.status ?? 'unknown'}). ` +
            `Take a photo of the property and upload it instead.`,
          404,
        );
      }
      const imgUrl =
        `https://maps.googleapis.com/maps/api/streetview` +
        `?size=${STREETVIEW_SIZE}&location=${encodeURIComponent(address)}` +
        `&fov=80&pitch=8&return_error_code=true&key=${googleKey}`;
      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) return await fail(`Street View request failed (${imgRes.status}).`);
      sourceBytes = new Uint8Array(await imgRes.arrayBuffer());
    }

    // --- 2. cartoonify with Gemini ----------------------------------------
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${googleKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: CARTOON_PROMPT },
                { inline_data: { mime_type: sourceMime, data: toBase64(sourceBytes) } },
              ],
            },
          ],
        }),
      },
    );

    if (!geminiRes.ok) {
      const detail = await geminiRes.text();
      return await fail(`Gemini rejected the request (${geminiRes.status}): ${detail.slice(0, 300)}`);
    }

    const gemini = (await geminiRes.json()) as {
      candidates?: { content?: { parts?: { inline_data?: { data?: string; mime_type?: string }; inlineData?: { data?: string; mimeType?: string } }[] } }[];
    };
    const parts = gemini.candidates?.[0]?.content?.parts ?? [];
    let artB64: string | undefined;
    let artMime = 'image/png';
    for (const part of parts) {
      const inline = part.inline_data ?? part.inlineData;
      const data = (inline as { data?: string } | undefined)?.data;
      if (data) {
        artB64 = data;
        artMime =
          (inline as { mime_type?: string; mimeType?: string }).mime_type ??
          (inline as { mimeType?: string }).mimeType ??
          'image/png';
        break;
      }
    }
    if (!artB64) return await fail('Gemini returned no image for this property.');

    // --- 3. store + record -------------------------------------------------
    const ext = artMime.includes('jpeg') ? 'jpg' : 'png';
    const artPath = `${jobRow.company}/${jobId}.${ext}`;
    const { error: upErr } = await admin.storage
      .from('property-art')
      .upload(artPath, fromBase64(artB64), { contentType: artMime, upsert: true });
    if (upErr) return await fail(`Could not save the artwork: ${upErr.message}`, 500);

    await admin
      .from('job_artwork')
      .update({
        art_path: artPath,
        status: 'ready',
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq('job_id', jobId);

    return json({ ok: true, artPath, jobNumber: jobRow.job_number });
  } catch (e) {
    return await fail(e instanceof Error ? e.message : 'Artwork generation failed.', 500);
  }
});
