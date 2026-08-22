/**
 * Shared domain types for the DC Solar KC app.
 *
 * These interfaces used to live alongside a file of bundled fake jobs, so
 * every screen that only wanted a TYPE pulled five invented customers and a
 * "Rain make-up day" into the bundle with it. That file is gone (2026-08-22):
 * there is no mock data anywhere in this app any more, and a query that comes
 * back empty now renders an empty state that says so.
 *
 * The types carry the CRM columns added by
 * `supabase/migrations/2026-08-22_crm.sql` as optionals, so anything that
 * builds a Customer by hand still compiles.
 */

import { type JobStatus } from '@/constants/theme';

export type { JobStatus };

export interface Customer {
  id: string;
  name: string;
  phone: string | null;
  email?: string | null;
  address: string | null;
  notes?: string | null;
  company: string;
  /** Contact photo in the job-photos bucket (migration 20). */
  photo_path?: string | null;
  /**
   * Soft archive (2026-08-22 CRM migration). `customers` has no DELETE policy
   * and is not getting one — jobs and finance_entries point at these rows.
   */
  archived_at?: string | null;
  /**
   * GENERATED column: +1XXXXXXXXXX, or null when `phone` could not be parsed
   * as a US number. Never written by the client — a wrong +1 is a text
   * message to a stranger.
   */
  phone_e164?: string | null;
  /** Set when the customer replies STOP to a DC Solar text. */
  sms_opt_out_at?: string | null;
}

/** A scheduled work day for a job (mirrors the job_schedule_dates table). */
export interface ScheduleDate {
  id: string;
  job_id: string;
  company: string;
  work_date: string; // ISO date (YYYY-MM-DD)
  start_time: string | null; // HH:MM:SS, null = time TBD
  note: string | null;
}

export interface Job {
  id: string;
  job_number: string | null;
  name: string;
  address: string | null;
  status: JobStatus;
  /** Pipeline stage (added in migration 6; may be absent pre-migration). */
  stage?: string | null;
  description: string | null;
  scheduled_for: string | null; // ISO date (YYYY-MM-DD)
  scheduled_end: string | null;
  customer_id: string | null;
  company: string;
  customer?: Customer | null;
}
