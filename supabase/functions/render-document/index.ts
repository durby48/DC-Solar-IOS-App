/**
 * render-document — turn a document's HTML into a PDF and file it in storage.
 *
 * WHY THIS EXISTS
 *
 * Native builds print with `expo-print`, which does not exist on the web. Until
 * now the web app could build an estimate but never produce the PDF, so a
 * revision saved from a browser left the customer-facing document behind. This
 * function is the web half of the same save path: the client builds the HTML
 * (`buildDocumentHtml`, one pure function shared by both platforms), posts it
 * here, and gets back the storage paths.
 *
 * IT DOES NOT WRITE finance_entries. On purpose. The client calls the
 * `revise_document` RPC afterwards with the paths this returns, so native and
 * web take exactly ONE save path through exactly ONE writer. If this function
 * ever starts updating the entry there are two writers and the revision
 * counter stops being trustworthy.
 *
 * TWO OBJECTS PER SAVE:
 *   contracts/<jobId>/<documentNumber>.pdf                 the living document
 *                                                          (upsert; the one
 *                                                          every existing link
 *                                                          already points at)
 *   contracts/<jobId>/revisions/<documentNumber>-r<N>.pdf  the immutable
 *                                                          archive of rev N
 *
 * Auth: verify_jwt ON, and the caller's admin role is re-checked here with the
 * service role. verify_jwt only proves "somebody is signed in".
 *
 * Secrets (none of them exist until Devon picks a provider — see
 * docs/PDF_RENDERING_SETUP.md):
 *   PDF_RENDER_PROVIDER  pdfshift | api2pdf | gotenberg
 *   PDF_RENDER_API_KEY   the provider's key (not needed for an unauthenticated
 *                        self-hosted Gotenberg)
 *   PDF_RENDER_URL       Gotenberg base URL, e.g. https://gotenberg.internal:3000
 *
 * With no provider configured it answers 503 { code: 'not_configured' } and the
 * app tells Devon the web PDF step is not set up — the revision still saves,
 * flagged pdf_state = 'stale', and "Retry PDF" re-runs just this step.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

// Browser callers (the web app) preflight with OPTIONS — answer it and
// echo CORS headers on every response, or the browser blocks the call.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUCKET = 'contracts';
/** Every generated document ends with the DC Solar KC footer. */
const FOOTER_MARKER = 'DC Solar KC';
/** ~2 MB of HTML is already an absurd document; past that it is a bug or an attack. */
const MAX_HTML = 2_000_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Document numbers are ours: DC-26012-Estimate, DC-26012-Invoice-2, … */
const DOC_NUMBER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

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

interface Payload {
  entryId?: string;
  jobId?: string;
  documentNumber?: string;
  revision?: number;
  html?: string;
}

type RenderResult = { ok: true; bytes: Uint8Array } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Provider adapters — all three implemented so switching is a secret change,
// not a code change. Devon picks one; see docs/PDF_RENDERING_SETUP.md.
// ---------------------------------------------------------------------------

/** PDFShift: HTML in, PDF bytes straight back. Basic auth with the literal user "api". */
async function renderPdfShift(html: string, key: string): Promise<RenderResult> {
  const res = await fetch('https://api.pdfshift.io/v3/convert/pdf', {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`api:${key}`)}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ source: html, format: 'Letter', margin: '0', landscape: false }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, error: `PDFShift rejected the render (${res.status}): ${detail}` };
  }
  return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * Api2Pdf: returns JSON with a FileUrl pointing at a short-lived S3 object,
 * so it is two round trips, not one.
 */
async function renderApi2Pdf(html: string, key: string): Promise<RenderResult> {
  const res = await fetch('https://v2.api2pdf.com/chrome/pdf/html', {
    method: 'POST',
    headers: { authorization: key, 'content-type': 'application/json' },
    body: JSON.stringify({
      html,
      inline: false,
      fileName: 'document.pdf',
      options: {
        landscape: false,
        printBackground: true,
        paperWidth: 8.5,
        paperHeight: 11,
        marginTop: 0,
        marginBottom: 0,
        marginLeft: 0,
        marginRight: 0,
      },
    }),
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, error: `Api2Pdf rejected the render (${res.status}): ${detail}` };
  }
  const body = (await res.json()) as { FileUrl?: string; Error?: string; Success?: boolean };
  if (!body.FileUrl) {
    return { ok: false, error: `Api2Pdf returned no file (${body.Error ?? 'no FileUrl'}).` };
  }
  const fileRes = await fetch(body.FileUrl);
  if (!fileRes.ok) {
    return { ok: false, error: `Could not download the Api2Pdf result (${fileRes.status}).` };
  }
  return { ok: true, bytes: new Uint8Array(await fileRes.arrayBuffer()) };
}

/**
 * Gotenberg (self-hosted Chromium): multipart, and the file MUST be called
 * index.html — that filename is the contract, not a convention.
 */
async function renderGotenberg(
  html: string,
  baseUrl: string,
  key: string | undefined,
): Promise<RenderResult> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('paperWidth', '8.5');
  form.append('paperHeight', '11');
  form.append('marginTop', '0');
  form.append('marginBottom', '0');
  form.append('marginLeft', '0');
  form.append('marginRight', '0');
  form.append('printBackground', 'true');

  const headers: Record<string, string> = {};
  // An exposed Gotenberg should sit behind basic auth or an API gateway; when
  // PDF_RENDER_API_KEY is set we send it as a bearer token.
  if (key) headers.authorization = `Bearer ${key}`;

  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/forms/chromium/convert/html`, {
    method: 'POST',
    headers,
    body: form,
  });
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    return { ok: false, error: `Gotenberg rejected the render (${res.status}): ${detail}` };
  }
  return { ok: true, bytes: new Uint8Array(await res.arrayBuffer()) };
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
    if (role !== 'owner' && role !== 'operator') {
      return fail(403, 'forbidden', 'Admins only.');
    }

    // --- input --------------------------------------------------------------
    let payload: Payload;
    try {
      payload = (await req.json()) as Payload;
    } catch {
      return fail(400, 'bad_request', 'Invalid JSON body.');
    }

    const { entryId, jobId, documentNumber, html } = payload;
    const revision = Number(payload.revision);

    if (!entryId || !UUID_RE.test(entryId)) {
      return fail(400, 'bad_request', 'entryId must be a uuid.');
    }
    if (!jobId || !UUID_RE.test(jobId)) {
      return fail(400, 'bad_request', 'jobId must be a uuid.');
    }
    if (!documentNumber || !DOC_NUMBER_RE.test(documentNumber)) {
      return fail(
        400,
        'bad_request',
        'documentNumber must be a plain document number like DC-26012-Estimate.',
      );
    }
    if (!Number.isInteger(revision) || revision < 1) {
      return fail(400, 'bad_request', 'revision must be a whole number 1 or greater.');
    }
    if (typeof html !== 'string' || html.trim().length === 0) {
      return fail(400, 'bad_request', 'html is required.');
    }
    if (html.length > MAX_HTML) {
      return fail(
        413,
        'bad_request',
        `That document is ${html.length} characters of HTML; the limit is ${MAX_HTML}.`,
      );
    }
    // Cheap authenticity check: every document buildDocumentHtml produces
    // carries the DC Solar KC footer. Refusing anything else keeps this from
    // becoming a general-purpose "render my HTML" endpoint for an admin
    // account that has been phished.
    if (!html.includes(FOOTER_MARKER)) {
      return fail(
        400,
        'bad_request',
        `That HTML is not a DC Solar document (no "${FOOTER_MARKER}" footer).`,
      );
    }

    // --- provider -----------------------------------------------------------
    const provider = (Deno.env.get('PDF_RENDER_PROVIDER') ?? '').trim().toLowerCase();
    const apiKey = Deno.env.get('PDF_RENDER_API_KEY') ?? undefined;
    const renderUrl = Deno.env.get('PDF_RENDER_URL') ?? undefined;

    if (!provider) {
      return fail(
        503,
        'not_configured',
        'Web PDF rendering is not set up yet: set the PDF_RENDER_PROVIDER secret ' +
          '(pdfshift, api2pdf or gotenberg) plus PDF_RENDER_API_KEY. Steps are in ' +
          'docs/PDF_RENDERING_SETUP.md. Saving still works — the document is marked ' +
          '"PDF out of date" until a provider is configured.',
      );
    }

    let rendered: RenderResult;
    if (provider === 'pdfshift') {
      if (!apiKey) {
        return fail(
          503,
          'not_configured',
          'PDF_RENDER_PROVIDER is "pdfshift" but PDF_RENDER_API_KEY is not set. See docs/PDF_RENDERING_SETUP.md.',
        );
      }
      rendered = await renderPdfShift(html, apiKey);
    } else if (provider === 'api2pdf') {
      if (!apiKey) {
        return fail(
          503,
          'not_configured',
          'PDF_RENDER_PROVIDER is "api2pdf" but PDF_RENDER_API_KEY is not set. See docs/PDF_RENDERING_SETUP.md.',
        );
      }
      rendered = await renderApi2Pdf(html, apiKey);
    } else if (provider === 'gotenberg') {
      if (!renderUrl) {
        return fail(
          503,
          'not_configured',
          'PDF_RENDER_PROVIDER is "gotenberg" but PDF_RENDER_URL is not set (e.g. https://gotenberg.example.com). See docs/PDF_RENDERING_SETUP.md.',
        );
      }
      rendered = await renderGotenberg(html, renderUrl, apiKey);
    } else {
      return fail(
        503,
        'not_configured',
        `PDF_RENDER_PROVIDER is "${provider}", which is not one of pdfshift, api2pdf, gotenberg.`,
      );
    }

    if (!rendered.ok) return fail(502, 'render_failed', rendered.error);

    const bytes = rendered.bytes;
    // A PDF starts with %PDF-. An HTML error page that came back with a 200
    // would otherwise be filed as the customer's estimate.
    if (bytes.byteLength < 5 || new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      return fail(
        502,
        'render_failed',
        'The render service did not return a PDF. Check the provider key and quota.',
      );
    }

    // --- store: living document + immutable archive -------------------------
    const storagePath = `${jobId}/${documentNumber}.pdf`;
    const archivePath = `${jobId}/revisions/${documentNumber}-r${revision}.pdf`;

    const { error: liveErr } = await admin.storage
      .from(BUCKET)
      .upload(storagePath, bytes, { contentType: 'application/pdf', upsert: true });
    if (liveErr) {
      return fail(500, 'upload_failed', `Could not save the PDF: ${liveErr.message}`);
    }

    const { error: archiveErr } = await admin.storage
      .from(BUCKET)
      .upload(archivePath, bytes, { contentType: 'application/pdf', upsert: true });
    if (archiveErr) {
      // The living document is already saved and is what the customer sees, so
      // this is reported, not fatal.
      return ok({
        storagePath,
        archivePath: null,
        sizeBytes: bytes.byteLength,
        warning: `The revision archive copy failed to save: ${archiveErr.message}`,
      });
    }

    return ok({ storagePath, archivePath, sizeBytes: bytes.byteLength });
  } catch (e) {
    return fail(500, 'server_error', e instanceof Error ? e.message : 'Render failed.');
  }
});
