/**
 * Employee invites (2026-10-05). An admin invites someone; they set their own
 * password from a DC Solar link (7 days, single use). The work is in two edge
 * functions — `employee-access` (admins: invite, new link, remove, statuses)
 * and `accept-invite` (public: check a link, set the password) — see
 * supabase/migrations/2026-10-05_employee_invites.sql for why this is not
 * Supabase's own invite email.
 */

import { readFunctionError } from '@/lib/artwork';
import { supabase } from '@/lib/supabase';

export type InviteRole = 'sales' | 'viewer' | 'operator';

export interface EmployeeStatus {
  email: string;
  has_login: boolean;
  last_sign_in_at: string | null;
  /** An open setup / reset link, and when it runs out. */
  invite_expires_at: string | null;
}

type Fail = { ok: false; message: string };

async function access<T>(body: Record<string, unknown>, fallback: string): Promise<({ ok: true } & T) | Fail> {
  try {
    const { data, error } = await supabase.functions.invoke('employee-access', { body });
    if (error) return { ok: false, message: (await readFunctionError(error)) ?? fallback };
    return { ok: true, ...(data as T) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : fallback };
  }
}

export function fetchEmployeeStatuses() {
  return access<{ employees: EmployeeStatus[] }>({ action: 'statuses' }, 'Could not load sign-in status.');
}

export function inviteEmployee(input: {
  name: string;
  email: string;
  role: InviteRole;
  cell?: string;
  number?: string;
  payRate?: string;
}) {
  return access<{ link: string; expires_at: string }>(
    {
      action: 'invite',
      name: input.name,
      email: input.email,
      role: input.role,
      cell: input.cell || null,
      number: input.number || null,
      pay_rate: input.payRate || null,
    },
    'Could not send the invite.',
  );
}

export function newEmployeeLink(email: string) {
  return access<{ link: string; expires_at: string; kind: 'invite' | 'reset' }>(
    { action: 'link', email },
    'Could not make a new link.',
  );
}

export function removeEmployeeAccess(email: string) {
  return access<{ removed: string }>({ action: 'remove', email }, 'Could not remove access.');
}

async function accept<T>(body: Record<string, unknown>, fallback: string): Promise<({ ok: true } & T) | Fail> {
  try {
    const { data, error } = await supabase.functions.invoke('accept-invite', { body });
    if (error) return { ok: false, message: (await readFunctionError(error)) ?? fallback };
    return { ok: true, ...(data as T) };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : fallback };
  }
}

/** The /join page: is this link good, and whose is it? */
export function checkInvite(code: string) {
  return accept<{ name: string | null; email: string; kind: 'invite' | 'reset' }>(
    { action: 'check', code },
    'Could not read this link.',
  );
}

/** Set the password; the caller then signs in with it. */
export function acceptInvite(code: string, password: string) {
  return accept<{ email: string; mfa?: boolean }>({ action: 'accept', code, password }, 'Could not set up the account.');
}

/** The text an admin sends with a link. */
export function inviteMessage(name: string, link: string, kind: 'invite' | 'reset'): string {
  const first = name.split(' ')[0] || 'there';
  return kind === 'reset'
    ? `Hi ${first}, here is a link to set a new DC Solar password (good for 7 days): ${link}`
    : `Hi ${first}, welcome to DC Solar! Set up your account here (link good for 7 days): ${link}`;
}
