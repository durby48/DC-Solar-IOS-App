import {
  Job,
  MOCK_JOBS,
  MOCK_SCHEDULE_DATES,
  type ScheduleDate,
} from '@/lib/mockData';
import { supabase } from '@/lib/supabase';

export type { ScheduleDate };

const COMPANY = 'dc-solar';

const CUSTOMER_FIELDS = 'id, name, phone, email, address, company';

function normalize(row: Record<string, unknown>): Job {
  const customers = row.customers as Job['customer'] | Job['customer'][] | undefined;
  return {
    ...(row as unknown as Job),
    customer: Array.isArray(customers) ? (customers[0] ?? null) : (customers ?? null),
  };
}

/**
 * Fetch all jobs for DC Solar KC. Falls back to bundled mock data when the
 * request errors (network / RLS) or returns no rows, so the app is always
 * demo-able.
 */
export async function fetchJobs(): Promise<{ jobs: Job[]; isMock: boolean }> {
  try {
    const { data, error } = await supabase
      .from('jobs')
      .select(`*, customers(${CUSTOMER_FIELDS})`)
      .eq('company', COMPANY)
      .order('scheduled_for', { ascending: true });

    if (error || !data || data.length === 0) {
      return { jobs: MOCK_JOBS, isMock: true };
    }
    return { jobs: data.map(normalize), isMock: false };
  } catch {
    return { jobs: MOCK_JOBS, isMock: true };
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

/** Create a short-lived signed URL for viewing a stored document. */
export async function getDocumentUrl(storagePath: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.storage
      .from(DOCUMENTS_BUCKET)
      .createSignedUrl(storagePath, 3600);
    if (error || !data?.signedUrl) return null;
    return data.signedUrl;
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

/** Fetch a single job by id, falling back to mock data. */
export async function fetchJob(id: string): Promise<Job | null> {
  const mock = MOCK_JOBS.find((j) => j.id === id);
  if (mock) return mock;
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
 */
export async function uploadJobPhoto(params: {
  jobId: string;
  uri: string;
  fileName?: string | null;
  contentType?: string | null;
}): Promise<UploadPhotoResult> {
  const { jobId, uri } = params;
  try {
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
    const contentType = params.contentType ?? 'image/jpeg';

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
 * Fetch a job's scheduled work days, ascending. Falls back to mock schedule
 * rows (which only match mock job ids) on error or empty result.
 */
export async function fetchJobScheduleDates(
  jobId: string,
): Promise<{ dates: ScheduleDate[]; isMock: boolean }> {
  const mock = MOCK_SCHEDULE_DATES.filter((d) => d.job_id === jobId).sort((a, b) =>
    a.work_date.localeCompare(b.work_date),
  );
  if (jobId.startsWith('mock-')) return { dates: mock, isMock: true };
  try {
    const { data, error } = await supabase
      .from('job_schedule_dates')
      .select('id, job_id, company, work_date, start_time, note')
      .eq('company', COMPANY)
      .eq('job_id', jobId)
      .order('work_date', { ascending: true });
    if (error) return { dates: mock, isMock: true };
    return { dates: (data ?? []) as ScheduleDate[], isMock: false };
  } catch {
    return { dates: mock, isMock: true };
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
 * Falls back to joining the bundled mock data.
 */
export async function fetchScheduleEntries(): Promise<{
  entries: ScheduleEntry[];
  isMock: boolean;
}> {
  const mockEntries: ScheduleEntry[] = MOCK_SCHEDULE_DATES.flatMap((d) => {
    const job = MOCK_JOBS.find((j) => j.id === d.job_id);
    return job ? [{ ...d, job }] : [];
  });
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

    if (error || !data || data.length === 0) {
      return { entries: mockEntries, isMock: true };
    }
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
    return { entries, isMock: false };
  } catch {
    return { entries: mockEntries, isMock: true };
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
  /** Labor cost: employee_hours (hours*rate) + time_entries * pay_rate. */
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
      .select('type, amount, occurred_on')
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
    let invoiced = 0;
    let paid = 0;
    let expenses = 0;
    for (const entry of finance as { type: string; amount: unknown; occurred_on: string | null }[]) {
      const amount = num(entry.amount);
      switch (entry.type) {
        case 'estimate': {
          const when = entry.occurred_on ?? '';
          if (estimate === null || when >= estimateDate) {
            estimate = amount;
            estimateDate = when;
          }
          break;
        }
        case 'invoice':
          invoiced += amount;
          break;
        case 'payment':
          paid += amount;
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

    return { estimate, invoiced, paid, expenses, hours, labor, byEmployee };
  } catch {
    return null;
  }
}

