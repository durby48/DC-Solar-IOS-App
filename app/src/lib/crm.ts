/**
 * CRM data layer — the customer record, not the contact book.
 *
 * `more/customers.tsx` could tell you a name and three tappable links. This
 * module is what a customer DETAIL screen needs: their jobs, their money,
 * their paperwork, their notes, whether they have a portal login, and whether
 * anyone has texted us back.
 *
 * HOUSE RULES FOLLOWED HERE
 *
 * - Nothing throws. Reads return `{status:'ok'|'unavailable'}` or an empty
 *   collection; writes return `{ok:true} | {ok:false, message}`. RLS denials,
 *   a missing table and a dead network all look the same to a screen, and
 *   none of them may crash it.
 * - Money is guarded by RLS, never by `isAdmin`. `crm_customer_summary` is a
 *   SECURITY DEFINER function with the admin check inside its first CTE, so a
 *   viewer gets ZERO ROWS rather than an error — which is why
 *   `fetchCustomerSummaries` returns an empty Map for them instead of
 *   reporting a failure.
 * - Signed URLs are batched (`createSignedUrls`), the way `lib/artwork.ts`
 *   does it. A CRM list is the first screen in the app that renders dozens of
 *   avatars at once; one request per avatar was already the app's worst N+1.
 *
 * DEPENDENCY DIRECTION. `lib/jobs.ts` imports CUSTOMER_COLUMNS and
 * `createCustomerRow` from here, so this module must NOT statically import
 * `lib/jobs.ts` back — Metro warns on every load about the require cycle, and
 * a cycle is one refactor away from a genuinely uninitialised value.
 * `convertLeadToCustomer` therefore reaches for `createJob` with a lazy
 * `import()` at the moment it needs it, the same trick `lib/documents.ts` uses
 * for `expo-print`. Keep the arrow pointing one way.
 */

import { type DocumentMeta } from '@/lib/documents';
import { statusForStage } from '@/lib/stages';
import { supabase } from '@/lib/supabase';
import { type Customer } from '@/lib/types';

const COMPANY = 'dc-solar';
const PHOTO_BUCKET = 'job-photos';
const SIGNED_URL_TTL = 3600;

/**
 * THE customer column list. Before 2026-08-22 this was written out by hand in
 * three places (`lib/customers.ts`, `lib/jobs.ts`, `lib/data.ts`) and leaving
 * `photo_path` out of one of them is exactly why avatars rendered on the
 * pipeline but not on the Customers tab. Import it; never retype it.
 *
 * Safe inside a PostgREST embed too: `select('*, customers(' + CUSTOMER_COLUMNS + ')')`.
 */
export const CUSTOMER_COLUMNS =
  'id, name, phone, phone_e164, email, address, notes, company, photo_path, archived_at, sms_opt_out_at';

export type MutationResult = { ok: true } | { ok: false; message: string };

export interface CustomerInput {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------

/**
 * Turn a PostgREST error into something Devon can act on.
 *
 * 23505 matters most: the base `customers` table carries a unique index on
 * `(company, lower(name))`, and an ARCHIVED customer still occupies its name.
 * "duplicate key value violates unique constraint" tells nobody that the fix
 * is to flip the Archived filter on.
 */
function crmError(
  error: { code?: string; message?: string } | null,
  fallback: string,
  options?: { name?: string; denied?: string },
): string {
  if (!error) return fallback;
  const raw = error.message ?? '';
  if (error.code === '23505' || /duplicate key|unique constraint/i.test(raw)) {
    const who = options?.name?.trim();
    return who
      ? `A customer named ${who} already exists (it may be archived — check the Archived filter).`
      : 'A customer with that name already exists (it may be archived — check the Archived filter).';
  }
  if (error.code === '42501' || /row-level security|policy|permission denied/i.test(raw)) {
    return options?.denied ?? 'Only owners and operators can change customers.';
  }
  return raw || fallback;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export type CrmCustomersResult =
  | { status: 'ok'; customers: Customer[] }
  | { status: 'unavailable' };

/**
 * Every customer, A→Z. Archived rows are hidden unless asked for — the
 * partial index `customers_active_name_idx` is built for exactly this query.
 */
export async function fetchCrmCustomers(options?: {
  includeArchived?: boolean;
}): Promise<CrmCustomersResult> {
  try {
    let query = supabase
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('company', COMPANY)
      .order('name', { ascending: true });
    if (!options?.includeArchived) query = query.is('archived_at', null);
    const { data, error } = await query;
    if (error) return { status: 'unavailable' };
    return { status: 'ok', customers: (data ?? []) as unknown as Customer[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/** One customer by id, archived or not. Null when missing or unreadable. */
export async function fetchCustomerById(id: string): Promise<Customer | null> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('company', COMPANY)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return data as unknown as Customer;
  } catch {
    return null;
  }
}

/** Admin: add a customer. */
export async function addCustomer(input: CustomerInput): Promise<MutationResult> {
  try {
    const { error } = await supabase.from('customers').insert({
      company: COMPANY,
      name: input.name,
      email: input.email,
      phone: input.phone,
      address: input.address,
      notes: input.notes,
    });
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not add the customer.', {
          name: input.name,
          denied: 'Only owners and operators can add customers.',
        }),
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the customer.' };
  }
}

export type CreateCustomerRowResult =
  | { ok: true; customer: Customer }
  | { ok: false; message: string };

/** Admin: add a customer and hand back the created row (for auto-select). */
export async function createCustomerRow(input: CustomerInput): Promise<CreateCustomerRowResult> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .insert({
        company: COMPANY,
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: input.address,
        notes: input.notes,
      })
      .select(CUSTOMER_COLUMNS)
      .single();
    if (error || !data) {
      return {
        ok: false,
        message: crmError(error, 'Could not add the customer.', {
          name: input.name,
          denied: 'Only owners and operators can add customers.',
        }),
      };
    }
    return { ok: true, customer: data as unknown as Customer };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the customer.' };
  }
}

/** Admin: update an existing customer. */
export async function updateCustomer(
  id: string,
  input: CustomerInput,
): Promise<MutationResult> {
  try {
    const { error } = await supabase
      .from('customers')
      .update({
        name: input.name,
        email: input.email,
        phone: input.phone,
        address: input.address,
        notes: input.notes,
      })
      .eq('id', id)
      .eq('company', COMPANY);
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not save the change.', {
          name: input.name,
          denied: 'Only owners and operators can edit customers.',
        }),
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save the change.' };
  }
}

/**
 * Admin: soft-hide a customer. There is no DELETE policy on `customers` and
 * there should never be one — jobs, invoices and payments point at these rows
 * and money that loses its counterparty is worse than a cluttered list.
 */
export async function archiveCustomer(id: string): Promise<MutationResult> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .update({ archived_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company', COMPANY)
      .select('id');
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not archive the customer.', {
          denied: 'Only owners and operators can archive customers.',
        }),
      };
    }
    if (!data || data.length === 0) {
      return { ok: false, message: 'Only owners and operators can archive customers.' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not archive the customer.',
    };
  }
}

/**
 * Admin: bring an archived customer back.
 *
 * This can fail with 23505 even though nothing is being inserted: if somebody
 * re-typed the customer while they were archived, restoring puts two rows with
 * the same `(company, lower(name))` back in play. The message says so.
 */
export async function unarchiveCustomer(id: string, name?: string): Promise<MutationResult> {
  try {
    const { data, error } = await supabase
      .from('customers')
      .update({ archived_at: null })
      .eq('id', id)
      .eq('company', COMPANY)
      .select('id');
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not restore the customer.', {
          name,
          denied: 'Only owners and operators can restore customers.',
        }),
      };
    }
    if (!data || data.length === 0) {
      return { ok: false, message: 'Only owners and operators can restore customers.' };
    }
    return { ok: true };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not restore the customer.',
    };
  }
}

export interface MergeCounts {
  jobs: number;
  finance_entries: number;
  customer_documents: number;
  customer_notes: number;
  customer_accounts: number;
}

export type MergeResult =
  | { ok: true; moved: MergeCounts }
  | { ok: false; message: string };

/**
 * Admin: the same person entered twice. Repoints every child row onto
 * `keepId` and archives the loser, in ONE transaction inside
 * `crm_merge_customers` — doing it table by table from the client would leave
 * a customer half-merged the first time the network dropped.
 */
export async function mergeCustomers(keepId: string, mergeId: string): Promise<MergeResult> {
  try {
    const { data, error } = await supabase.rpc('crm_merge_customers', {
      keep_id: keepId,
      merge_id: mergeId,
    });
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not merge those customers.', {
          denied: 'Only owners and operators can merge customers.',
        }),
      };
    }
    const result = (data ?? {}) as { merged?: boolean; reason?: string } & Partial<MergeCounts>;
    if (!result.merged) {
      return { ok: false, message: result.reason ?? 'Nothing was merged.' };
    }
    return {
      ok: true,
      moved: {
        jobs: Number(result.jobs ?? 0),
        finance_entries: Number(result.finance_entries ?? 0),
        customer_documents: Number(result.customer_documents ?? 0),
        customer_notes: Number(result.customer_notes ?? 0),
        customer_accounts: Number(result.customer_accounts ?? 0),
      },
    };
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Could not merge those customers.',
    };
  }
}

// ---------------------------------------------------------------------------
// Avatars — one signed-URL request for the whole list
// ---------------------------------------------------------------------------

/**
 * Signed avatar URLs keyed by customer id, in ONE request for the whole list.
 * Pass the result into `<CustomerAvatar url={…}>` so the component skips its
 * own per-instance signing.
 */
export async function fetchCustomerAvatarUrls(
  customers: { id: string; photo_path?: string | null }[],
): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  try {
    const withPhotos = customers.filter(
      (c): c is { id: string; photo_path: string } =>
        typeof c.photo_path === 'string' && c.photo_path.length > 0,
    );
    if (withPhotos.length === 0) return urls;

    const { data, error } = await supabase.storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(
        withPhotos.map((c) => c.photo_path),
        SIGNED_URL_TTL,
      );
    if (error || !data) return urls;

    data.forEach((entry, index) => {
      const signed = (entry as { signedUrl?: string | null }).signedUrl;
      const customer = withPhotos[index];
      if (signed && customer) urls.set(customer.id, signed);
    });
  } catch {
    // Fall through with whatever we managed to sign — initials are a fine
    // fallback and a missing avatar must never break the list.
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Money summaries
// ---------------------------------------------------------------------------

export interface CustomerSummary {
  customerId: string;
  invoiced: number;
  paid: number;
  balance: number;
  estimated: number;
  contracted: number;
  openJobs: number;
  totalJobs: number;
  lastActivityAt: string | null;
}

/**
 * Invoiced / paid / balance / job counts for a batch of customers.
 *
 * `crm_customer_summary` is SECURITY DEFINER with `is_company_admin` inside
 * its first CTE, so a viewer gets zero rows — NOT an error. An empty Map here
 * therefore means "you may not see money", and the caller simply renders the
 * list without the metric strip. Do not treat it as a failure.
 */
export async function fetchCustomerSummaries(
  ids: string[],
): Promise<Map<string, CustomerSummary>> {
  const map = new Map<string, CustomerSummary>();
  if (ids.length === 0) return map;
  try {
    const { data, error } = await supabase.rpc('crm_customer_summary', {
      customer_ids: ids,
    });
    if (error || !data) return map;
    for (const row of data as Record<string, unknown>[]) {
      const id = String(row.customer_id ?? '');
      if (!id) continue;
      map.set(id, {
        customerId: id,
        invoiced: Number(row.invoiced ?? 0),
        paid: Number(row.paid ?? 0),
        balance: Number(row.balance ?? 0),
        estimated: Number(row.estimated ?? 0),
        contracted: Number(row.contracted ?? 0),
        openJobs: Number(row.open_jobs ?? 0),
        totalJobs: Number(row.total_jobs ?? 0),
        lastActivityAt: (row.last_activity_at as string | null) ?? null,
      });
    }
  } catch {
    // Empty map = no money strip. Never a crash.
  }
  return map;
}

// ---------------------------------------------------------------------------
// Jobs for one customer
// ---------------------------------------------------------------------------

export interface CustomerJob {
  id: string;
  job_number: string | null;
  name: string;
  address: string | null;
  status: string | null;
  stage: string | null;
  scheduled_for: string | null;
  scheduled_end: string | null;
  completed_on: string | null;
  is_internal: boolean | null;
  created_at: string | null;
}

/**
 * A customer's projects, newest job number first. `jobs` is member-readable,
 * so this works for the whole crew; an empty array covers both "no jobs" and
 * "could not read", which is the right answer for a list either way.
 */
export async function fetchCustomerJobs(customerId: string): Promise<CustomerJob[]> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select(
        'id, job_number, name, address, status, stage, scheduled_for, scheduled_end, completed_on, is_internal, created_at',
      )
      .eq('company', COMPANY)
      .eq('customer_id', customerId)
      .order('job_number', { ascending: false });
    if (error || !data) return [];
    return data as unknown as CustomerJob[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Paperwork + money rows for one customer
// ---------------------------------------------------------------------------

export type FinanceDocType = 'estimate' | 'contract' | 'invoice' | 'payment';

export interface CustomerFinanceRow {
  id: string;
  type: FinanceDocType;
  amount: number;
  occurred_on: string | null;
  description: string | null;
  status: string | null;
  document_number: string | null;
  document_path: string | null;
  /** 1 = as first created. The document NUMBER never changes; this does. */
  revision: number | null;
  document_meta: DocumentMeta | null;
  job_id: string | null;
  customer_id: string | null;
  created_at: string | null;
}

export type CustomerFinanceResult =
  | { status: 'ok'; entries: CustomerFinanceRow[] }
  | { status: 'unavailable' };

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/**
 * Every estimate / contract / invoice / payment that belongs to this customer,
 * matched by `customer_id` OR by one of their jobs — both linkages exist in
 * the wild (documents made in the app stamp `customer_id`; rows imported from
 * the ops console and the email scanner often only carry `job_id`).
 *
 * `finance_entries` is admin-only, so a viewer gets `{status:'ok', entries:[]}`
 * — an empty Money tab, not an error banner.
 *
 * Pass `jobIds` when the caller already loaded the jobs list to save a query.
 */
export async function fetchCustomerFinance(
  customerId: string,
  jobIds?: string[],
): Promise<CustomerFinanceResult> {
  try {
    // The customer id reaches this function straight off a route param and is
    // interpolated into a PostgREST `or=` filter below, where a comma or a dot
    // would change what the filter means. Anything that is not a uuid stops
    // here.
    if (!UUID_RE.test(customerId)) return { status: 'ok', entries: [] };

    let ids = jobIds;
    if (!ids) ids = (await fetchCustomerJobs(customerId)).map((j) => j.id);
    const safeIds = ids.filter((id) => UUID_RE.test(id));

    const columns =
      'id, type, amount, occurred_on, description, status, document_number, document_path, revision, document_meta, job_id, customer_id, created_at';
    let query = supabase
      .from('finance_entries')
      .select(columns)
      .eq('company', COMPANY)
      .in('type', ['estimate', 'contract', 'invoice', 'payment']);

    query =
      safeIds.length > 0
        ? query.or(`customer_id.eq.${customerId},job_id.in.(${safeIds.join(',')})`)
        : query.eq('customer_id', customerId);

    const { data, error } = await query.order('occurred_on', { ascending: false });
    if (error) return { status: 'unavailable' };

    const rows = (data ?? []) as unknown as CustomerFinanceRow[];
    return {
      status: 'ok',
      entries: rows.map((row) => ({ ...row, amount: Number(row.amount ?? 0) })),
    };
  } catch {
    return { status: 'unavailable' };
  }
}

// ---------------------------------------------------------------------------
// Notes timeline
// ---------------------------------------------------------------------------

export interface CustomerNote {
  id: string;
  created_at: string;
  updated_at: string | null;
  customer_id: string;
  job_id: string | null;
  body: string;
  author_email: string;
  pinned: boolean;
}

export type CustomerNotesResult =
  | { status: 'ok'; notes: CustomerNote[] }
  | { status: 'unavailable' };

/** The note timeline, pinned first then newest first. */
export async function fetchCustomerNotes(customerId: string): Promise<CustomerNotesResult> {
  try {
    const { data, error } = await supabase
      .from('customer_notes')
      .select('id, created_at, updated_at, customer_id, job_id, body, author_email, pinned')
      .eq('company', COMPANY)
      .eq('customer_id', customerId)
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', notes: (data ?? []) as unknown as CustomerNote[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Add a note. Every company member may — the crew knowing "gate code is 4417,
 * dog is friendly" is the entire point — but `cn_member_insert` only accepts
 * a note signed with your own email, so we send it explicitly rather than
 * relying on the column default.
 */
export async function addCustomerNote(params: {
  customerId: string;
  body: string;
  jobId?: string | null;
  pinned?: boolean;
}): Promise<MutationResult> {
  try {
    const body = params.body.trim();
    if (!body) return { ok: false, message: 'Write something first.' };

    const { data: userData } = await supabase.auth.getUser();
    const email = userData?.user?.email ?? null;
    if (!email) return { ok: false, message: 'Sign in to add a note.' };

    const { error } = await supabase.from('customer_notes').insert({
      company: COMPANY,
      customer_id: params.customerId,
      job_id: params.jobId ?? null,
      body,
      author_email: email,
      pinned: params.pinned ?? false,
    });
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not save that note.', {
          denied: 'You can only add notes under your own name.',
        }),
      };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save that note.' };
  }
}

/**
 * Edit a note. RLS allows the author (`cn_author_update`) or any admin
 * (`cn_admin_all`); zero rows back means neither applied.
 */
export async function updateCustomerNote(
  id: string,
  fields: { body?: string; pinned?: boolean },
): Promise<MutationResult> {
  try {
    const payload: Record<string, unknown> = {};
    if (fields.body !== undefined) {
      const body = fields.body.trim();
      if (!body) return { ok: false, message: 'A note needs some text.' };
      payload.body = body;
    }
    if (fields.pinned !== undefined) payload.pinned = fields.pinned;
    if (Object.keys(payload).length === 0) return { ok: true };

    const { data, error } = await supabase
      .from('customer_notes')
      .update(payload)
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not save that note.', {
          denied: 'You can only edit your own notes.',
        }),
      };
    }
    if (!data || data.length === 0) {
      return { ok: false, message: 'You can only edit your own notes.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not save that note.' };
  }
}

/**
 * Delete a note. Only `cn_admin_all` grants DELETE — an author who is not an
 * admin can edit their note but not remove it, which is why the screen shows
 * the trash icon to admins only.
 */
export async function deleteCustomerNote(id: string): Promise<MutationResult> {
  try {
    const { data, error } = await supabase
      .from('customer_notes')
      .delete()
      .eq('company', COMPANY)
      .eq('id', id)
      .select('id');
    if (error) {
      return {
        ok: false,
        message: crmError(error, 'Could not delete that note.', {
          denied: 'Only owners and operators can delete notes.',
        }),
      };
    }
    if (!data || data.length === 0) {
      return { ok: false, message: 'Only owners and operators can delete notes.' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete that note.' };
  }
}

// ---------------------------------------------------------------------------
// Lead conversion
// ---------------------------------------------------------------------------

export type ConvertLeadResult =
  | { ok: true; customerId: string; jobId: string | null; jobNumber: string | null; warning?: string }
  | { ok: false; message: string };

/**
 * Turn a lead into a real customer, optionally opening its first project.
 *
 * ORDER MATTERS AND IT IS NOT ATOMIC. Supabase's REST API has no
 * multi-statement transaction, so this runs customer → job → lead in that
 * order deliberately: the customer is the row everything else points at, and
 * the lead is marked `won` LAST so a failure part-way leaves the lead sitting
 * in the funnel where somebody will notice it, rather than marking it won with
 * nothing behind it. A half-finished conversion is reported as a warning, not
 * swallowed. (Same reasoning as `documents.ts::splitPayment`.)
 */
export async function convertLeadToCustomer(
  leadId: string,
  options?: { createJob?: boolean },
): Promise<ConvertLeadResult> {
  try {
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, name, phone, email, address, notes, converted_job_id, status')
      .eq('company', COMPANY)
      .eq('id', leadId)
      .maybeSingle();
    if (leadError || !lead) {
      return { ok: false, message: 'Could not read that lead.' };
    }

    const row = lead as {
      id: string;
      name: string;
      phone: string | null;
      email: string | null;
      address: string | null;
      notes: string | null;
    };

    const created = await createCustomerRow({
      name: row.name,
      phone: row.phone,
      email: row.email,
      address: row.address,
      notes: row.notes,
    });
    if (!created.ok) return { ok: false, message: created.message };
    const customerId = created.customer.id;

    let jobId: string | null = null;
    let jobNumber: string | null = null;
    let warning: string | undefined;

    if (options?.createJob) {
      // Lazy so `lib/crm.ts` never statically depends on `lib/jobs.ts` — see
      // the DEPENDENCY DIRECTION note at the top of this file.
      const { createJob } = await import('@/lib/jobs');
      const job = await createJob({
        name: row.name,
        description: row.notes,
        status: statusForStage('Pending Estimate'),
        stage: 'Pending Estimate',
        address: row.address,
        customer_id: customerId,
        project_manager: null,
        project_manager_phone: null,
        completed_on: null,
        module_count: null,
        job_type: null,
        critter_guard_panels: null,
        has_critter_guard: false,
      });
      if (job.ok) {
        jobId = job.id;
        jobNumber = job.jobNumber;
      } else {
        warning = `${row.name} was added as a customer, but the project could not be created: ${job.message}`;
      }
    }

    const { error: updateError } = await supabase
      .from('leads')
      .update({ status: 'won', converted_job_id: jobId })
      .eq('company', COMPANY)
      .eq('id', leadId);
    if (updateError) {
      warning =
        (warning ? warning + ' ' : '') +
        'The customer was created, but the lead is still showing as open — mark it won on the Sales tab.';
    }

    return { ok: true, customerId, jobId, jobNumber, warning };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not convert that lead.' };
  }
}

// ---------------------------------------------------------------------------
// Unread inbound texts (badges only — the comms client is Workstream G)
// ---------------------------------------------------------------------------

/**
 * How many unread inbound messages each customer has, for the list's unread
 * dot. `messages` is admin-only on all four verbs, so a viewer gets an empty
 * Map and simply sees no dots. Returns an empty Map on ANY problem — the
 * table may not exist on a database that has not taken the comms migration.
 */
export async function fetchUnreadByCustomer(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const { data, error } = await supabase
      .from('messages')
      .select('customer_id')
      .eq('company', COMPANY)
      .eq('direction', 'in')
      .is('read_at', null);
    if (error || !data) return counts;
    for (const row of data as { customer_id: string | null }[]) {
      if (!row.customer_id) continue;
      counts.set(row.customer_id, (counts.get(row.customer_id) ?? 0) + 1);
    }
  } catch {
    // No badges. Never a crash.
  }
  return counts;
}
