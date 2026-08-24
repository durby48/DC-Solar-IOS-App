import { CUSTOMER_COLUMNS } from '@/lib/crm';
import { compressForUpload } from '@/lib/images';
import { loadedLaborCost } from '@/lib/laborCost';
import { supabase } from '@/lib/supabase';
import { type Job, type ScheduleDate } from '@/lib/types';

export type { ScheduleDate };

const COMPANY = 'dc-solar';

/**
 * The customer column list used to be written out by hand here, in
 * `lib/customers.ts` and in `lib/jobs.ts` — three copies, and leaving
 * `photo_path` out of one of them is exactly why avatars rendered on the
 * pipeline but not on the Customers tab. There is now one list, in
 * `lib/crm.ts`, and it works inside a PostgREST embed too.
 */
const CUSTOMER_FIELDS = CUSTOMER_COLUMNS;

function normalize(row: Record<string, unknown>): Job {
  const customers = row.customers as Job['customer'] | Job['customer'][] | undefined;
  return {
    ...(row as unknown as Job),
    customer: Array.isArray(customers) ? (customers[0] ?? null) : (customers ?? null),
  };
}

/** Did the request reach the database, whatever it came back with? */
export type FetchStatus = 'ok' | 'unavailable';

/**
 * Fetch all jobs for DC Solar KC.
 *
 * ZERO ROWS IS SUCCESS. `status: 'ok'` with an empty array means the query
 * ran and the company genuinely has no jobs — a brand-new install, or a
 * signed-out browser that RLS answers with nothing. `status: 'unavailable'`
 * means the request itself failed (network, RLS error, missing table) and the
 * screen should say "couldn't load", not "nothing here". Until 2026-08-22 both
 * of those returned five bundled fake jobs instead; they no longer exist.
 *
 * Never throws.
 */
export async function fetchJobs(): Promise<{ jobs: Job[]; status: FetchStatus }> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select(`*, customers(${CUSTOMER_FIELDS})`)
      .eq('company', COMPANY)
      .order('scheduled_for', { ascending: true });

    if (error || !data) return { jobs: [], status: 'unavailable' };
    return { jobs: data.map(normalize), status: 'ok' };
  } catch {
    return { jobs: [], status: 'unavailable' };
  }
}

export type DocType =
  | 'contract'
  | 'estimate'
  | 'invoice'
  | 'permit'
  | 'photo_report'
  | 'materials'
  | 'other';

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  contract: 'Contract',
  estimate: 'Estimate',
  invoice: 'Invoice',
  permit: 'Permit',
  photo_report: 'Photo report',
  materials: 'Materials',
  other: 'Other',
};

export interface JobDocument {
  id: string;
  created_at: string;
  company: string;
  job_id: string;
  doc_type: DocType;
  storage_path: string;
  file_name: string;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: string | null;
  /**
   * The money row this PDF belongs to. Until 2026-08-22 the link was only the
   * naming convention `finance_entries.document_path === storage_path`.
   */
  finance_entry_id?: string | null;
}

export type JobDocumentsResult =
  | { status: 'ok'; documents: JobDocument[] }
  | { status: 'unavailable' };

const DOCUMENTS_BUCKET = 'contracts';

/**
 * Fetch documents for a job. Returns `unavailable` when the query errors
 * (table missing / RLS denial), so screens can degrade to a friendly note
 * instead of crashing.
 */
export async function fetchJobDocuments(jobId: string): Promise<JobDocumentsResult> {
  try {
    const { data, error } = await supabase
      .from('job_documents')
      .select('*')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });

    if (error) return { status: 'unavailable' };
    return { status: 'ok', documents: (data ?? []) as JobDocument[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/**
 * Create a short-lived signed URL for viewing a stored document.
 *
 * `version` (pass `entry.revision`) is appended as `&v=<n>` AFTER signing. The
 * signature covers the object and the expiry, not arbitrary query parameters,
 * so this is safe — and necessary: a revised document overwrites the same
 * object in place, and both the Supabase CDN and Safari will happily serve the
 * bytes they cached under the previous URL. The avatar and EOM uploads dodge
 * the same trap by timestamping their filenames; a document number has to stay
 * stable, so it gets a cache-buster instead.
 */
export async function getDocumentUrl(
  storagePath: string,
  version?: number | null,
): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) return null;
    const url = data.signedUrl;
    if (version == null) return url;
    return `${url}${url.includes('?') ? '&' : '?'}v=${encodeURIComponent(String(version))}`;
  } catch {
    return null;
  }
}

export type UploadDocumentResult =
  | { ok: true; document: JobDocument }
  | { ok: false; message: string };

/**
 * Upload a picked file to the private `contracts` bucket and record it in
 * `job_documents`. Never throws — returns a friendly message on failure.
 */
export async function uploadJobDocument(params: {
  jobId: string;
  docType: DocType;
  fileName: string;
  uri: string;
  contentType: string;
}): Promise<UploadDocumentResult> {
  const { jobId, docType, fileName, uri, contentType } = params;
  try {
    const response = await fetch(uri);
    const body = await response.arrayBuffer();

    const sanitized = fileName.replace(/[^A-Za-z0-9._-]+/g, '_');
    const storagePath = `${jobId}/${Date.now()}-${sanitized}`;

    const { error: uploadError } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .upload(storagePath, body, { contentType });
    if (uploadError) {
      return { ok: false, message: uploadError.message };
    }

    const { data: userData } = await supabase.auth.getUser();
    const uploadedBy = userData?.user?.email ?? null;

    const { data, error: insertError } = await supabase
      .from('job_documents')
      .insert({
        company: COMPANY,
        job_id: jobId,
        doc_type: docType,
        storage_path: storagePath,
        file_name: fileName,
        content_type: contentType,
        size_bytes: body.byteLength,
        uploaded_by: uploadedBy,
      })
      .select('*')
      .single();

    if (insertError || !data) {
      return { ok: false, message: insertError?.message ?? 'Could not save the document record.' };
    }
    return { ok: true, document: data as JobDocument };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}

/** Fetch a single job by id. Null when it doesn't exist or can't be read. */
export async function fetchJob(id: string): Promise<Job | null> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select(`*, customers(${CUSTOMER_FIELDS})`)
      .eq('company', COMPANY)
      .eq('id', id)
      .maybeSingle();
    if (error || !data) return null;
    return normalize(data);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Job photos (private `job-photos` bucket + job_photos table)
// ---------------------------------------------------------------------------

const PHOTOS_BUCKET = 'job-photos';

export interface JobPhoto {
  id: string;
  job_id: string;
  company: string;
  storage_path: string;
  caption: string | null;
  uploaded_by: string | null;
  created_at: string;
}

export type JobPhotosResult =
  | { status: 'ok'; photos: JobPhoto[] }
  | { status: 'unavailable' };

/** Fetch photos for a job, newest first. Degrades to `unavailable` on error. */
export async function fetchJobPhotos(jobId: string): Promise<JobPhotosResult> {
  try {
    const { data, error } = await supabase
      .from('job_photos')
      .select('*')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .order('created_at', { ascending: false });
    if (error) return { status: 'unavailable' };
    return { status: 'ok', photos: (data ?? []) as JobPhoto[] };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Signed URL for viewing a stored job photo (1h). */
export async function getPhotoUrl(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
  } catch {
    return null;
  }
}

export type UploadPhotoResult =
  | { ok: true; photo: JobPhoto }
  | { ok: false; message: string };

/**
 * Upload one picked image to the private `job-photos` bucket and record it
 * in `job_photos`. Never throws.
 *
 * The file is compressed to 1920px/JPEG first (`lib/images.ts`). Job photos
 * are the highest-volume upload in the app — a crew documents a roof from
 * eight angles at a time — and they are only ever viewed as a grid thumbnail
 * or in the lightbox, neither of which can show 4 000 px. Compression never
 * throws; a device that can't run it uploads the original.
 */
export async function uploadJobPhoto(params: {
  jobId: string;
  uri: string;
  fileName?: string | null;
  contentType?: string | null;
}): Promise<UploadPhotoResult> {
  const { jobId } = params;
  try {
    const compressed = await compressForUpload(params.uri);
    const uri = compressed.uri;

    // Reading the picked file and pushing it to storage can both hit
    // transient network timeouts on cell connections — retry each once
    // automatically before surfacing an error.
    let body: ArrayBuffer | null = null;
    for (let attempt = 0; attempt < 2 && !body; attempt++) {
      try {
        const response = await fetch(uri);
        body = await response.arrayBuffer();
      } catch (e) {
        if (attempt === 1) throw e;
      }
    }
    if (!body) return { ok: false, message: 'Could not read the photo.' };

    const rawName = params.fileName ?? 'photo.jpg';
    const base = rawName.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_');
    // The object key has always ended `.jpg`; once the bytes have actually
    // been re-encoded, the content type has to say so too.
    const contentType = compressed.compressed
      ? 'image/jpeg'
      : (params.contentType ?? 'image/jpeg');

    // Fresh path per attempt (the bucket is insert-only; a retry must not
    // collide with a partially-written first attempt).
    let storagePath = '';
    let uploadError: { message: string } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      storagePath = `${jobId}/${Date.now()}-${base || 'photo'}.jpg`;
      const { error } = await supabase.storage
        .from(PHOTOS_BUCKET)
        .upload(storagePath, body, { contentType });
      uploadError = error;
      if (!error) break;
    }
    if (uploadError) return { ok: false, message: uploadError.message };

    const { data: userData } = await supabase.auth.getUser();
    const uploadedBy = userData?.user?.email ?? null;

    const { data, error: insertError } = await supabase
      .from('job_photos')
      .insert({
        company: COMPANY,
        job_id: jobId,
        storage_path: storagePath,
        caption: null,
        uploaded_by: uploadedBy,
      })
      .select('*')
      .single();

    if (insertError || !data) {
      return { ok: false, message: insertError?.message ?? 'Could not save the photo record.' };
    }
    return { ok: true, photo: data as JobPhoto };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Upload failed.' };
  }
}

export type DeletePhotoResult = { ok: true } | { ok: false; message: string };

/**
 * Delete a job photo (admin-only per RLS): remove the job_photos row, then
 * best-effort delete the storage file (an orphaned file is harmless; a
 * dangling row is not, so the row goes first). Never throws.
 */
export async function deleteJobPhoto(photo: JobPhoto): Promise<DeletePhotoResult> {
  try {
    const { data, error } = await supabase
      .from('job_photos')
      .delete()
      .eq('company', COMPANY)
      .eq('id', photo.id)
      .select('id');
    if (error) return { ok: false, message: error.message };
    if (!data || data.length === 0) {
      return { ok: false, message: 'Only admins can delete photos.' };
    }
    // Best-effort file cleanup (needs the media-delete migration).
    await supabase.storage
      .from(PHOTOS_BUCKET)
      .remove([photo.storage_path])
      .catch(() => {});
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the photo.' };
  }
}

// ---------------------------------------------------------------------------
// Schedule dates (job_schedule_dates)
// ---------------------------------------------------------------------------

/**
 * Fetch a job's scheduled work days, ascending. An empty array with
 * `status: 'ok'` means the job simply has no days on the calendar yet.
 */
export async function fetchJobScheduleDates(
  jobId: string,
): Promise<{ dates: ScheduleDate[]; status: FetchStatus }> {
  try {
    const { data, error } = await supabase
      .from('job_schedule_dates')
      .select('id, job_id, company, work_date, start_time, note')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .order('work_date', { ascending: true });
    if (error) return { dates: [], status: 'unavailable' };
    return { dates: (data ?? []) as ScheduleDate[], status: 'ok' };
  } catch {
    return { dates: [], status: 'unavailable' };
  }
}

export type AddScheduleDateResult =
  | { ok: true; date: ScheduleDate }
  | { ok: false; message: string };

/** Insert a scheduled day for a job (admin-only per RLS). Never throws. */
export async function addJobScheduleDate(params: {
  jobId: string;
  workDate: string; // YYYY-MM-DD
  startTime: string | null; // HH:MM (24h) or null = TBD
  note?: string | null;
}): Promise<AddScheduleDateResult> {
  try {
    const { data, error } = await supabase
      .from('job_schedule_dates')
      .insert({
        company: COMPANY,
        job_id: params.jobId,
        work_date: params.workDate,
        start_time: params.startTime ? `${params.startTime}:00` : null,
        note: params.note ?? null,
      })
      .select('id, job_id, company, work_date, start_time, note')
      .single();
    if (error || !data) {
      const message = error?.code === '23505'
        ? 'That day is already on the schedule for this job.'
        : (error?.message ?? 'Could not add the day.');
      return { ok: false, message };
    }
    return { ok: true, date: data as ScheduleDate };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not add the day.' };
  }
}

export type UpdateScheduleDateResult =
  | { ok: true; date: ScheduleDate }
  | { ok: false; message: string };

/**
 * Change the start time of a scheduled day (admin-only per the
 * `jsd_admin_all` RLS policy). `startTime` is HH:MM (24h) or null for TBD.
 * Never throws.
 */
export async function updateJobScheduleDate(
  id: string,
  startTime: string | null,
): Promise<UpdateScheduleDateResult> {
  try {
    const { data, error } = await supabase
      .from('job_schedule_dates')
      .update({ start_time: startTime ? `${startTime}:00` : null })
      .eq('id', id)
      .select('id, job_id, company, work_date, start_time, note')
      .single();
    if (error || !data) {
      const raw = error?.message ?? '';
      // No row back usually means the update policy isn't applied yet.
      const message =
        /row-level security|policy/i.test(raw) || error?.code === 'PGRST116' || !raw
          ? 'Updating scheduled times needs the latest database migration.'
          : raw;
      return { ok: false, message };
    }
    return { ok: true, date: data as ScheduleDate };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not update the time.' };
  }
}

/** Delete a scheduled day (admin-only per RLS). Returns success. */
export async function deleteJobScheduleDate(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('job_schedule_dates').delete().eq('id', id);
    return !error;
  } catch {
    return false;
  }
}

/** A schedule row joined with its job, for the Schedule tab. */
export interface ScheduleEntry extends ScheduleDate {
  job: Job;
}

/**
 * Fetch schedule days (past 7 days through next 60) joined with their jobs.
 * `status: 'ok'` with no entries means nothing is scheduled in that window.
 */
export async function fetchScheduleEntries(): Promise<{
  entries: ScheduleEntry[];
  status: FetchStatus;
}> {
  try {
    const from = new Date();
    from.setDate(from.getDate() - 7);
    const to = new Date();
    to.setDate(to.getDate() + 60);
    const iso = (d: Date) =>
      `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`;

    const { data, error } = await supabase
      .from('job_schedule_dates')
      .select(`id, job_id, company, work_date, start_time, note, jobs(*, customers(${CUSTOMER_FIELDS}))`)
      .eq('company', COMPANY)
      .gte('work_date', iso(from))
      .lte('work_date', iso(to))
      .order('work_date', { ascending: true })
      .order('start_time', { ascending: true });

    if (error || !data) return { entries: [], status: 'unavailable' };
    const entries: ScheduleEntry[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const jobs = row.jobs;
      const jobRow = Array.isArray(jobs) ? jobs[0] : jobs;
      if (!jobRow) continue;
      entries.push({
        id: row.id as string,
        job_id: row.job_id as string,
        company: row.company as string,
        work_date: row.work_date as string,
        start_time: (row.start_time as string | null) ?? null,
        note: (row.note as string | null) ?? null,
        job: normalize(jobRow as Record<string, unknown>),
      });
    }
    return { entries, status: 'ok' };
  } catch {
    return { entries: [], status: 'unavailable' };
  }
}

/**
 * Schedule days in an explicit date range joined with their jobs — feeds
 * the Calendar month view. No mock fallback: empty array when there is
 * nothing scheduled (or on error).
 */
export async function fetchScheduleRange(
  fromISO: string,
  toISO: string,
): Promise<ScheduleEntry[]> {
  try {
    const { data, error } = await supabase
      .from('job_schedule_dates')
      .select(`id, job_id, company, work_date, start_time, note, jobs(*, customers(${CUSTOMER_FIELDS}))`)
      .eq('company', COMPANY)
      .gte('work_date', fromISO)
      .lte('work_date', toISO)
      .order('work_date', { ascending: true })
      .order('start_time', { ascending: true });
    if (error || !data) return [];
    const entries: ScheduleEntry[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const jobs = row.jobs;
      const jobRow = Array.isArray(jobs) ? jobs[0] : jobs;
      if (!jobRow) continue;
      entries.push({
        id: row.id as string,
        job_id: row.job_id as string,
        company: row.company as string,
        work_date: row.work_date as string,
        start_time: (row.start_time as string | null) ?? null,
        note: (row.note as string | null) ?? null,
        job: normalize(jobRow as Record<string, unknown>),
      });
    }
    return entries;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Job finance summary (admin-only tables)
// ---------------------------------------------------------------------------

export interface JobFinanceSummary {
  /** Most recent estimate amount, or null when there is none. */
  estimate: number | null;
  invoiced: number;
  paid: number;
  expenses: number;
  /** employee_hours + completed time_entries durations, in hours. */
  hours: number;
  /** Fully-loaded labor: (employee_hours hours*rate + time_entries * pay_rate)
   *  times the employer payroll-tax burden — see lib/laborCost.ts. */
  labor: number;
  /** Per-employee hour totals (display name → hours), highest first. */
  byEmployee: { name: string; hours: number }[];
}

/**
 * Aggregate finance + labor numbers for a job. Returns null when the
 * finance_entries query fails (non-admin / RLS), so callers can hide the
 * header silently. Secondary queries degrade to zero contributions.
 */
export async function fetchJobFinance(jobId: string): Promise<JobFinanceSummary | null> {
  try {
    const { data: finance, error: financeError } = await supabase
      .from('finance_entries')
      .select('type, amount, direction, occurred_on, created_at')
      .eq('company', COMPANY)
      .eq('job_id', jobId);
    if (financeError || !finance) return null;

    const [hoursRes, timeRes, employeesRes] = await Promise.all([
      supabase
        .from('employee_hours')
        .select('employee, hours, rate')
        .eq('company', COMPANY)
        .eq('job_id', jobId),
      supabase
        .from('time_entries')
        .select('employee, clock_in, clock_out')
        .eq('company', COMPANY)
        .eq('job_id', jobId),
      supabase.from('employees').select('email, display_name, pay_rate'),
    ]);

    const byName = new Map<string, number>();
    const addEmployeeHours = (name: string | null | undefined, h: number) => {
      const key = (name ?? '').trim() || 'Unassigned';
      byName.set(key, (byName.get(key) ?? 0) + h);
    };

    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };

    let estimate: number | null = null;
    let estimateDate = '';
    let estimateCreated = '';
    let invoiced = 0;
    let paid = 0;
    let expenses = 0;
    for (const entry of finance as {
      type: string;
      amount: unknown;
      direction: string | null;
      occurred_on: string | null;
      created_at?: string | null;
    }[]) {
      const amount = num(entry.amount);
      switch (entry.type) {
        case 'estimate': {
          // Newest estimate wins, by occurred_on and then created_at — the
          // same two keys as isNewerEstimate in lib/pipeline.ts. Without the
          // tie-break, two estimates dated the same day (which is exactly what
          // a same-afternoon revision produces) resolved to whichever row
          // PostgREST happened to return last, and this header flipped between
          // refreshes with no data change at all.
          const when = entry.occurred_on ?? '';
          const created = entry.created_at ?? '';
          const newer =
            estimate === null ||
            (when !== estimateDate ? when > estimateDate : created >= estimateCreated);
          if (newer) {
            estimate = amount;
            estimateDate = when;
            estimateCreated = created;
          }
          break;
        }
        case 'invoice':
          invoiced += amount;
          break;
        case 'payment':
          paid += amount;
          break;
        // Owner capital counts as money PAID IN on the job it sits on (the
        // Company container): Devon's and Clark's contributions are real
        // deposits, and showing them outside the paid figure made the job
        // look as if the money never arrived. Direction-aware, so capital
        // returned comes back out. Company-wide rollups (lib/financials.ts)
        // still keep investment out of revenue — that is deliberate.
        case 'investment':
          paid += entry.direction === 'out' ? -amount : amount;
          break;
        case 'expense':
          expenses += amount;
          break;
      }
    }

    let hours = 0;
    let labor = 0;
    if (!hoursRes.error && hoursRes.data) {
      for (const row of hoursRes.data as { employee: string | null; hours: unknown; rate: unknown }[]) {
        const h = num(row.hours);
        hours += h;
        labor += h * num(row.rate);
        addEmployeeHours(row.employee, h);
      }
    }

    const rateByEmail = new Map<string, number>();
    const nameByEmail = new Map<string, string>();
    if (!employeesRes.error && employeesRes.data) {
      for (const row of employeesRes.data as {
        email: string;
        display_name: string | null;
        pay_rate: unknown;
      }[]) {
        if (!row.email) continue;
        if (row.pay_rate != null) rateByEmail.set(row.email.toLowerCase(), num(row.pay_rate));
        if (row.display_name) nameByEmail.set(row.email.toLowerCase(), row.display_name);
      }
    }

    if (!timeRes.error && timeRes.data) {
      for (const row of timeRes.data as {
        employee: string | null;
        clock_in: string | null;
        clock_out: string | null;
      }[]) {
        if (!row.clock_in || !row.clock_out) continue; // only completed entries
        const ms = new Date(row.clock_out).getTime() - new Date(row.clock_in).getTime();
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const h = ms / 3_600_000;
        hours += h;
        const email = row.employee?.toLowerCase();
        const rate = email ? rateByEmail.get(email) : undefined;
        if (rate != null) labor += h * rate; // skip entries with unknown rate
        addEmployeeHours(email ? (nameByEmail.get(email) ?? row.employee) : row.employee, h);
      }
    }

    const byEmployee = [...byName.entries()]
      .map(([name, h]) => ({ name, hours: h }))
      .sort((a, b) => b.hours - a.hours);

    return { estimate, invoiced, paid, expenses, hours, labor: loadedLaborCost(labor), byEmployee };
  } catch {
    return null;
  }
}

