/**
 * Bundled mock data — real DC Solar KC jobs, used whenever Supabase is
 * unreachable, returns nothing (RLS), or the user is in demo mode.
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

export const MOCK_CUSTOMERS: Customer[] = [
  {
    id: 'mock-cust-1',
    name: 'Osawatomie Homeowner',
    phone: '(913) 555-0148',
    email: 'osawatomie.owner@example.com',
    address: '34870 W 359th St, Osawatomie KS',
    company: 'dc-solar',
  },
  {
    id: 'mock-cust-2',
    name: 'Salina Homeowner',
    phone: '(785) 555-0192',
    email: 'salina.owner@example.com',
    address: '1265 Columbine Ln, Salina KS 67041',
    company: 'dc-solar',
  },
  {
    id: 'mock-cust-3',
    name: 'Lawrence Homeowner',
    phone: '(785) 555-0126',
    email: 'lawrence.owner@example.com',
    address: '2112 Riviera Dr, Lawrence KS 66047',
    company: 'dc-solar',
  },
];

export const MOCK_JOBS: Job[] = [
  {
    id: 'mock-dc-26012',
    job_number: 'DC-26012',
    name: 'R&R 18 modules',
    address: '1265 Columbine Ln, Salina KS 67041',
    status: 'active',
    description: 'Remove & reinstall 18 modules for roof replacement.',
    scheduled_for: '2026-07-24',
    scheduled_end: null,
    customer_id: 'mock-cust-2',
    company: 'dc-solar',
    customer: MOCK_CUSTOMERS[1],
  },
  {
    id: 'mock-dc-26014',
    job_number: 'DC-26014',
    name: 'R&R',
    address: '2112 Riviera Dr, Lawrence KS 66047',
    status: 'active',
    description: 'Remove & reinstall for roof work.',
    scheduled_for: '2026-07-27',
    scheduled_end: null,
    customer_id: 'mock-cust-3',
    company: 'dc-solar',
    customer: MOCK_CUSTOMERS[2],
  },
  {
    id: 'mock-kc-115th',
    job_number: null,
    name: 'R&R',
    address: '101 W 115th Street, Kansas City MO 64114',
    status: 'active',
    description: 'Remove & reinstall for roof work.',
    scheduled_for: '2026-07-30',
    scheduled_end: null,
    customer_id: null,
    company: 'dc-solar',
  },
  {
    id: 'mock-raymore-ashley',
    job_number: null,
    name: 'R&R',
    address: '502 Ashley Court, Raymore MO',
    status: 'active',
    description: 'Remove & reinstall for roof work.',
    scheduled_for: '2026-07-23',
    scheduled_end: null,
    customer_id: null,
    company: 'dc-solar',
  },
  {
    id: 'mock-dc-26013',
    job_number: 'DC-26013',
    name: 'Reinstall — 41 modules',
    address: '34870 W 359th St, Osawatomie KS',
    status: 'completed',
    description: 'Reinstall of 41 modules after roof replacement.',
    scheduled_for: '2026-07-17',
    scheduled_end: null,
    customer_id: 'mock-cust-1',
    company: 'dc-solar',
    customer: MOCK_CUSTOMERS[0],
  },
];

/**
 * Mock schedule days. DC-26012 appears on two non-consecutive dates with
 * different start times — the "rain day" scenario where a crew returns to
 * finish a job later in the week.
 */
export const MOCK_SCHEDULE_DATES: ScheduleDate[] = [
  {
    id: 'mock-sched-1',
    job_id: 'mock-dc-26012',
    company: 'dc-solar',
    work_date: '2026-07-24',
    start_time: '07:00:00',
    note: null,
  },
  {
    id: 'mock-sched-2',
    job_id: 'mock-dc-26012',
    company: 'dc-solar',
    work_date: '2026-07-28',
    start_time: '09:30:00',
    note: 'Rain make-up day',
  },
  {
    id: 'mock-sched-3',
    job_id: 'mock-dc-26014',
    company: 'dc-solar',
    work_date: '2026-07-27',
    start_time: '08:00:00',
    note: null,
  },
  {
    id: 'mock-sched-4',
    job_id: 'mock-kc-115th',
    company: 'dc-solar',
    work_date: '2026-07-30',
    start_time: null,
    note: null,
  },
  {
    id: 'mock-sched-5',
    job_id: 'mock-raymore-ashley',
    company: 'dc-solar',
    work_date: '2026-07-23',
    start_time: '07:30:00',
    note: null,
  },
  {
    id: 'mock-sched-6',
    job_id: 'mock-dc-26013',
    company: 'dc-solar',
    work_date: '2026-07-17',
    start_time: '07:00:00',
    note: null,
  },
];
