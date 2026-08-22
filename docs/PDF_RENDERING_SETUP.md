# Web PDF rendering — setup checklist

Goal: revising an estimate or invoice **in a browser** produces the same PDF it
produces on an iPhone.

Native builds print with `expo-print`, which is native-only. On
app.dcsolarkc.com there is no printer, so until now the web app could edit a
document and never produce the file the customer sees. The `render-document`
edge function is the web half of that path: the client builds the HTML with
`buildDocumentHtml` — the same pure function both platforms use — posts it here,
and gets back the storage paths it then hands to the `revise_document` RPC.

**One decision is needed from Devon (item 7 on the owner list): a hosted API, or
self-hosted Gotenberg.** Everything else is 10 minutes of paste-a-secret.

Until a provider is set, `render-document` answers `503 not_configured`. That is
designed behaviour: the revision still saves, the document is flagged
`pdf_state = 'stale'` with a ⚠ "PDF out of date" chip, and **Retry PDF** re-runs
only this step. Nothing is lost; the PDF is just missing until this is done.

---

## 1. Pick a provider (Devon, 2 min — this is the whole decision)

DC Solar renders roughly **60 documents a month**.

| | **Hosted API** (PDFShift / Api2Pdf) | **Self-hosted Gotenberg** |
|---|---|---|
| Setup | paste one API key | run a container somewhere with a public HTTPS URL |
| Cost at ~60/month | free tier to ~$15/month | server cost only (~$5/month VPS) |
| Maintenance | none | yours — updates, TLS, uptime |
| **Who sees the document** | **the vendor's servers see the customer's name, address and the dollar amounts**, for the seconds it takes to render | nobody outside your own infrastructure |
| Failure mode | vendor outage → "PDF out of date", retry later | your container down → same |

**Recommended default: a hosted API.** The HTML is posted, rendered and
discarded; no vendor stores DC Solar documents. But it is a real third party
seeing real customer names and prices, so it is Devon's call, not a technical
one — and the function implements all three adapters, so switching later is a
secret change, not a code change.

### Option A — PDFShift (simplest)

1. https://pdfshift.io → sign up. Free credits are enough to test; check the
   current plan pricing before committing — the paid tier is around $9–14/month
   for far more renders than DC Solar needs.
2. Dashboard → **API key**. Copy it.
3. Set two secrets (step 2 below) with `PDF_RENDER_PROVIDER = pdfshift`.

The function calls `POST https://api.pdfshift.io/v3/convert/pdf` with HTTP basic
auth `api:<key>` and `{"source": "<html>", "format": "Letter"}`, and gets PDF
bytes straight back.

### Option B — Api2Pdf (pay-as-you-go)

1. https://portal.api2pdf.com → sign up, copy the API key.
2. Billing is per render and very cheap at this volume; there is no monthly
   minimum, which suits 60 documents a month better than a subscription.
3. Set the secrets with `PDF_RENDER_PROVIDER = api2pdf`.

Api2Pdf answers with JSON containing a short-lived `FileUrl` rather than the
bytes, so the function does a second fetch to download it. That is expected and
already handled.

### Option C — Gotenberg (nothing leaves your infrastructure)

1. Run it anywhere that can hold a container — Fly.io, Railway, a $5 VPS,
   Devon's own box behind Cloudflare Tunnel:

   ```
   docker run --rm -p 3000:3000 gotenberg/gotenberg:8
   ```

2. **Put it behind HTTPS and behind authentication.** An open Gotenberg is a
   free HTML-to-PDF service for the entire internet and a good way to have your
   IP block-listed. Simplest workable shape: a reverse proxy that requires
   `Authorization: Bearer <token>`.
3. Set `PDF_RENDER_PROVIDER = gotenberg`, `PDF_RENDER_URL = https://…` (base
   URL, no path), and `PDF_RENDER_API_KEY` = the bearer token your proxy expects
   (omit it only if the endpoint is genuinely unauthenticated on a private
   network).

The function posts multipart to `<url>/forms/chromium/convert/html` with the
file field named `files` and the filename **`index.html`** — Gotenberg requires
that exact filename; it is a contract, not a convention.

## 2. Set the secrets (Devon or a Claude session, ~2 min)

PAT in `C:\Durbin Enterprises\config\secrets\supabase-access-token.txt`.

```
curl -X POST "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/secrets" \
  -H "Authorization: Bearer <SUPABASE_PAT>" \
  -H "Content-Type: application/json" \
  -d '[
    {"name":"PDF_RENDER_PROVIDER","value":"pdfshift"},
    {"name":"PDF_RENDER_API_KEY","value":"sk_…"}
  ]'
```

For Gotenberg add `{"name":"PDF_RENDER_URL","value":"https://gotenberg.example.com"}`.

There is nothing to redeploy — edge functions read secrets at boot and the next
invocation picks them up.

## 3. Verify (~3 min)

**Before the secrets exist** (expected — this is the not-configured path):

```
curl -i -X POST "https://kjamxfezsathrsbztiln.supabase.co/functions/v1/render-document" \
  -H "Authorization: Bearer <an owner or operator access token>" \
  -H "Content-Type: application/json" \
  -d '{"entryId":"00000000-0000-4000-8000-000000000000","jobId":"00000000-0000-4000-8000-000000000001","documentNumber":"DC-26031-Estimate","revision":1,"html":"<html><body>DC Solar KC</body></html>"}'
```

→ `503 {"ok":false,"code":"not_configured","error":"Web PDF rendering is not set up yet: …"}`

**With no session at all** → `401`. **Signed in as a viewer** →
`403 {"code":"forbidden"}`. `verify_jwt` being on is not the authorization: the
function re-reads `employees.role` with the service role every time.

**After the secrets exist**, the same call with a real `entryId`/`jobId` returns:

```json
{"ok":true,
 "storagePath":"<jobId>/DC-26031-Estimate.pdf",
 "archivePath":"<jobId>/revisions/DC-26031-Estimate-r1.pdf",
 "sizeBytes":48213}
```

Then do it for real: open an estimate on app.dcsolarkc.com, change a line item,
**Save revision**, and confirm the PDF opens with the new numbers and "Rev 2" in
the header — and that the rev 1 PDF still opens with the *old* numbers.

## 4. What the function refuses, and why

| Check | Response |
|---|---|
| Not signed in / not an owner or operator | `401` / `403` |
| `entryId` or `jobId` not a uuid | `400 bad_request` |
| `revision` < 1 or not a whole number | `400 bad_request` |
| `html` longer than 2,000,000 characters | `413 bad_request` |
| `html` with no `DC Solar KC` footer | `400 bad_request` |
| No provider configured | `503 not_configured` |
| Provider returned something that is not a PDF | `502 render_failed` |

The footer check is the interesting one. Without it this is a general-purpose
"render any HTML you send me" endpoint attached to an admin session — a nice
tool for anyone who phishes one. Every document `buildDocumentHtml` produces
carries the DC Solar KC footer, so requiring it costs nothing and closes that.

## What is stored where — do not shortcut this

- **Two objects per save**, both in the private `contracts` bucket:
  - `contracts/<jobId>/<documentNumber>.pdf` — the **living** document, upserted
    in place. Every link, every `job_documents` row and the customer portal all
    point here, which is why the path never changes across revisions.
  - `contracts/<jobId>/revisions/<documentNumber>-r<N>.pdf` — the **immutable**
    archive of revision N. Written once, never overwritten. This is what
    `finance_entry_revisions.document_path` points at, so opening "rev 2" three
    revisions later shows rev 2 and not today's numbers.
- **This function does not touch `finance_entries`.** On purpose. The client
  calls the `revise_document` RPC with the paths returned here, so native and
  web share exactly one writer and the revision counter stays trustworthy. If
  this function ever starts updating the entry there are two writers and the
  counter stops meaning anything.
- **The API key is an edge-function secret**, not a table and not a client
  value. The HTML — which contains the customer's name, address and the amounts
  — is posted to the provider and discarded; nothing about a DC Solar document
  is stored outside Supabase.
- **Native is unchanged.** iPhones keep printing with `expo-print` and uploading
  the result themselves. This function exists so the web behaves the same, not
  to replace the native path.

## Owner follow-ups this produces

| Value | Where it comes from | Secret name |
|---|---|---|
| `pdfshift` \| `api2pdf` \| `gotenberg` | step 1 — Devon's decision | `PDF_RENDER_PROVIDER` |
| The provider's API key (or the Gotenberg proxy's bearer token) | step 1 | `PDF_RENDER_API_KEY` |
| Gotenberg base URL — **only** for option C | step 1 | `PDF_RENDER_URL` |
