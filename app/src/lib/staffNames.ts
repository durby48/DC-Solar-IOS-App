/**
 * Staff names (2026-10-08) — "who did it" labels in the CRM (timeline, notes,
 * calls, tasks) show the person's first name ("Carson"), not a nickname cut
 * from their email ("Ke4ting"). The names come from `staff_names()` (names
 * only, any employee; 2026-10-08_staff_names.sql), loaded once when the role
 * loads and cached for the session. Until they arrive — or for someone who is
 * not an employee — the old email-based nickname is the fallback.
 */

import { supabase } from '@/lib/supabase';

let names: Map<string, string> | null = null;
let loading: Promise<void> | null = null;

/** Load (once) the email → display name directory. Never throws. */
export function loadStaffNames(): Promise<void> {
  if (names) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      try {
        const { data, error } = await supabase.rpc('staff_names');
        if (!error && data) {
          names = new Map(
            (data as { email: string; display_name: string }[]).map((r) => [r.email.toLowerCase(), r.display_name]),
          );
        }
      } catch {
        // Fall back to email nicknames.
      } finally {
        loading = null;
      }
    })();
  }
  return loading;
}

/** Forget the directory (sign-out, or a different person signing in). */
export function clearStaffNames(): void {
  names = null;
}

function nickname(email: string): string | null {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : null;
}

/** "ke4ting@gmail.com" → "Carson" (first name), else the email nickname. */
export function personName(email: string | null | undefined): string | null {
  if (!email) return null;
  const full = names?.get(email.toLowerCase());
  if (full && !full.includes('@')) return full.split(' ')[0] || full;
  return nickname(email);
}

/** "Ken Crum" → "Ken" — person pickers show first names (Carson, 2026-10-08). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
