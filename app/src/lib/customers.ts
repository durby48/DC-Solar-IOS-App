/**
 * Customers data layer — the company contact book. All members can read;
 * admins add and edit (insert/update policies may not be applied yet, so
 * mutation errors surface as friendly messages). RLS enforced.
 */

import {
  CUSTOMER_COLUMNS,
  addCustomer as crmAddCustomer,
  updateCustomer as crmUpdateCustomer,
  type CustomerInput,
} from '@/lib/crm';
import { compressForUpload } from '@/lib/images';
import { supabase } from '@/lib/supabase';

const COMPANY = 'dc-solar';

export interface CustomerRecord {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
  photo_path?: string | null;
  archived_at?: string | null;
}

export type { CustomerInput };

export type CustomersResult =
  | { status: 'ok'; customers: CustomerRecord[] }
  | { status: 'unavailable' };

/**
 * Fetch all customers, alphabetical by name — INCLUDING archived ones, since
 * this is the legacy shape and its one remaining caller is the job editor's
 * picker sibling.
 *
 * @deprecated Prefer `fetchCrmCustomers()` in `lib/crm.ts`, which knows about
 * the archive filter and returns the full `Customer` shape.
 */
export async function fetchCustomers(): Promise<CustomersResult> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('company', COMPANY)
      .order('name', { ascending: true });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', customers: (data ?? []) as unknown as CustomerRecord[] };
  } catch {
    return { status: 'unavailable' };
  }
}

export type CustomerMutationResult = { ok: true } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// Customer documents (insurance certificates etc.) — admin-only, files in
// the contracts bucket under customers/<customer_id>/…
// ---------------------------------------------------------------------------

const DOCUMENTS_BUCKET = 'contracts';

export interface CustomerDocument {
  id: string;
  created_at: string;
  customer_id: string;
  doc_type: 'insurance' | 'other';
  storage_path: string;
  file_name: string;
}

/**
 * All customer documents for the company in one query, grouped by
 * customer. Null on error (non-admin / pre-migration) so the screen can
 * hide the section.
 */
export async function fetchCustomerDocuments(): Promise<Map<
  string,
  CustomerDocument[]
> | null> {
  try {
    const { data, error } = await supabase
      .from('customer_documents')
      .select('id, created_at, customer_id, doc_type, storage_path, file_name')
      .eq('company', COMPANY)
      .order('created_at', { ascending: false });
    if (error) return null;
    const map = new Map<string, CustomerDocument[]>();
    for (const row of (data ?? []) as CustomerDocument[]) {
      const list = map.get(row.customer_id) ?? [];
      list.push(row);
      map.set(row.customer_id, list);
    }
    return map;
  } catch {
    return null;
  }
}

/** Admin: upload a customer's insurance PDF and record it. */
export async function uploadCustomerDocument(params: {
  customerId: string;
  fileName: string;
  uri: string;
  contentType: string;
}): Promise<CustomerMutationResult> {
  try {
    const response = await fetch(params.uri);
    const body = await response.arrayBuffer();
    const safeName = params.fileName.replace(/[^A-Za-z0-9._-]+/g, '_') || 'insurance.pdf';
    const storagePath = `customers/${params.customerId}/${Date.now()}-${safeName}`;

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, body, { contentType: params.contentType });
    if (uploadError) return { ok: false, message: uploadError.message };

    const { data: userData } = await supabase.auth.getUser();
    const { error: insertError } = await supabase.from('customer_documents').insert({
      company: COMPANY,
      customer_id: params.customerId,
      doc_type: 'insurance',
      storage_path: storagePath,
      file_name: params.fileName,
      content_type: params.contentType,
      size_bytes: body.byteLength,
      uploaded_by: userData?.user?.email ?? null,
    });
    if (insertError) {
      return { ok: false, message: friendlyMessage(insertError.message, 'Could not save the document.') };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}

/** Admin: delete a customer document (row first, then best-effort file). */
export async function deleteCustomerDocument(
  doc: CustomerDocument,
): Promise<CustomerMutationResult> {
  try {
    const { data, error } = await supabase
      .from('customer_documents')
      .delete()
      .eq('company', COMPANY)
      .eq('id', doc.id)
      .select('id');
    if (error) return { ok: false, message: error.message };
    if (!data || data.length === 0) return { ok: false, message: 'Could not delete the document.' };
    await supabase.storage.from(DOCUMENTS_BUCKET).remove([doc.storage_path]).catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the document.' };
  }
}

function friendlyMessage(raw: string | undefined, fallback: string): string {
  if (!raw) return fallback;
  // Policy not applied yet / RLS denial reads badly raw — soften it.
  if (/row-level security|policy/i.test(raw)) {
    return 'Saving customers needs the latest database migration.';
  }
  return raw;
}

/**
 * Admin: add a customer.
 *
 * @deprecated Moved to `lib/crm.ts`, which also names the archived customer
 * behind a 23505 unique-name collision. This is a pass-through so nothing
 * breaks; import from `@/lib/crm` in new code.
 */
export async function addCustomer(input: CustomerInput): Promise<CustomerMutationResult> {
  return crmAddCustomer(input);
}

/**
 * Admin: update an existing customer.
 *
 * @deprecated Moved to `lib/crm.ts`. Pass-through; import from `@/lib/crm`.
 */
export async function updateCustomer(
  id: string,
  input: CustomerInput,
): Promise<CustomerMutationResult> {
  return crmUpdateCustomer(id, input);
}

// ---------------------------------------------------------------------------
// Customer contact photos (migration 20)
// ---------------------------------------------------------------------------

/**
 * Avatars live in the EXISTING private `job-photos` bucket under a `customers/`
 * prefix — reusing that bucket means no new storage policies to get wrong.
 */
const PHOTO_BUCKET = 'job-photos';

/** Signed display URL for a stored avatar. Null on any failure. */
export async function getCustomerPhotoUrl(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

export type PhotoUploadResult =
  | { ok: true; path: string }
  | { ok: false; message: string };

/**
 * Upload a picked image as a customer's contact photo and record the path.
 *
 * The caller square-crops via the picker's `allowsEditing`; `compressForUpload`
 * then caps it at 1920px and re-encodes as JPEG. An avatar is rendered at
 * about 48pt, so the 6 MB original a phone camera hands over is roughly two
 * hundred times more picture than the screen can show. Compression never
 * throws — a device that can't run it uploads the original.
 */
export async function uploadCustomerPhoto(params: {
  customerId: string;
  uri: string;
}): Promise<PhotoUploadResult> {
  try {
    const compressed = await compressForUpload(params.uri);
    const response = await fetch(compressed.uri);
    const blob = await response.blob();
    const ext = blob.type.includes('png') ? 'png' : 'jpg';
    // Timestamped so a replacement never collides with a cached signed URL.
    const path = `customers/${params.customerId}-${Date.now()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(PHOTO_BUCKET)
      .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
    if (upErr) return { ok: false, message: upErr.message };

    const { error } = await supabase
      .from('customers')
      .update({ photo_path: path })
      .eq('id', params.customerId);
    if (error) return { ok: false, message: error.message };
    return { ok: true, path };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not save that photo.',
    };
  }
}
