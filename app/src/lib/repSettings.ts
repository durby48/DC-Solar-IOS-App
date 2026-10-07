import { readFunctionError } from '@/lib/artwork';
import { supabase } from '@/lib/supabase';

/**
 * A person's own phone and notification settings (2026-10-06, rep Settings),
 * on their staff_profiles row (sp_self_* policies: only they can write it),
 * plus their personal saved texts (message_templates.owner_email).
 *
 *   Do not disturb   dnd_enabled + work_start / work_end (America/Chicago):
 *                    outside those hours calls to their DC Solar number do not
 *                    ring and the caller is texted back (twilio-voice-inbound)
 *   Notifications    notify_texts / notify_missed_calls / notify_new_prospects,
 *                    honoured by the `notify` edge function
 */

const COMPANY = 'dc-solar';

export interface MyPrefs {
  dndEnabled: boolean;
  /** 'HH:MM' */
  workStart: string;
  workEnd: string;
  notifyTexts: boolean;
  notifyMissedCalls: boolean;
  notifyNewProspects: boolean;
  /** Hail near my leads / customers (2026-10-09). */
  notifyStorms: boolean;
}

export const DEFAULT_PREFS: MyPrefs = {
  dndEnabled: false,
  workStart: '08:00',
  workEnd: '19:00',
  notifyTexts: true,
  notifyMissedCalls: true,
  notifyNewProspects: true,
  notifyStorms: true,
};

async function myEmail(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.email?.toLowerCase() ?? null;
}

export async function fetchMyPrefs(): Promise<MyPrefs> {
  try {
    const email = await myEmail();
    if (!email) return DEFAULT_PREFS;
    const { data } = await supabase
      .from('staff_profiles')
      .select('dnd_enabled, work_start, work_end, notify_texts, notify_missed_calls, notify_new_prospects, notify_storms')
      .eq('company', COMPANY)
      .eq('email', email)
      .maybeSingle();
    const r = data as Record<string, unknown> | null;
    if (!r) return DEFAULT_PREFS;
    return {
      dndEnabled: r.dnd_enabled === true,
      workStart: String(r.work_start ?? '08:00').slice(0, 5),
      workEnd: String(r.work_end ?? '19:00').slice(0, 5),
      notifyTexts: r.notify_texts !== false,
      notifyMissedCalls: r.notify_missed_calls !== false,
      notifyNewProspects: r.notify_new_prospects !== false,
      notifyStorms: r.notify_storms !== false,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export async function saveMyPrefs(patch: Partial<MyPrefs>): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const email = await myEmail();
    if (!email) return { ok: false, message: 'Sign in first.' };
    const row: Record<string, unknown> = { company: COMPANY, email };
    if (patch.dndEnabled !== undefined) row.dnd_enabled = patch.dndEnabled;
    if (patch.workStart !== undefined) row.work_start = patch.workStart;
    if (patch.workEnd !== undefined) row.work_end = patch.workEnd;
    if (patch.notifyTexts !== undefined) row.notify_texts = patch.notifyTexts;
    if (patch.notifyMissedCalls !== undefined) row.notify_missed_calls = patch.notifyMissedCalls;
    if (patch.notifyNewProspects !== undefined) row.notify_new_prospects = patch.notifyNewProspects;
    if (patch.notifyStorms !== undefined) row.notify_storms = patch.notifyStorms;
    const { error } = await supabase.from('staff_profiles').upsert(row, { onConflict: 'company,email' });
    return error ? { ok: false, message: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not saved.' };
  }
}

/** '19:00' → '7:00 PM' */
export function hmLabel(hm: string): string {
  const [h, m] = hm.split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

/** Is it outside their hours right now (Kansas City time)? */
export function isAwayNow(prefs: MyPrefs): boolean {
  if (!prefs.dndEnabled) return false;
  const now = new Date().toLocaleTimeString('en-GB', { timeZone: 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false });
  return now < prefs.workStart || now >= prefs.workEnd;
}

/** Have Twilio call your own DC Solar number (Calling check). */
export async function requestTestCall(): Promise<{ ok: true; away: boolean } | { ok: false; message: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('voice-test-call', { body: {} });
    if (error) return { ok: false, message: (await readFunctionError(error)) ?? 'Could not place the test call.' };
    return { ok: true, away: (data as { away?: boolean })?.away === true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not place the test call.' };
  }
}

// ---------------------------------------------------------------------------
// Personal saved texts
// ---------------------------------------------------------------------------

export interface SavedText {
  id: string;
  title: string;
  body: string;
  /** Null for a company text (read-only here). */
  ownerEmail: string | null;
}

export async function fetchSavedTexts(): Promise<SavedText[]> {
  try {
    const { data, error } = await supabase
      .from('message_templates')
      .select('id, title, body, owner_email')
      .eq('company', COMPANY)
      .eq('active', true)
      .order('sort');
    if (error || !data) return [];
    return (data as { id: string; title: string; body: string; owner_email: string | null }[]).map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      ownerEmail: r.owner_email,
    }));
  } catch {
    return [];
  }
}

export async function saveMyText(
  input: { id?: string; title: string; body: string },
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const email = await myEmail();
    if (!email) return { ok: false, message: 'Sign in first.' };
    const title = input.title.trim();
    const body = input.body.trim();
    if (!title || !body) return { ok: false, message: 'Give it a name and the text.' };
    if (body.length > 1500) return { ok: false, message: 'Keep it under 1,500 characters.' };
    const { error } = input.id
      ? await supabase.from('message_templates').update({ title, body }).eq('id', input.id)
      : await supabase.from('message_templates').insert({
          company: COMPANY,
          // Unique per company; a personal text's key never collides with a company one.
          key: `mine-${email.split('@')[0].replace(/[^a-z0-9]/g, '')}-${Date.now().toString(36)}`,
          title,
          body,
          owner_email: email,
          sort: 500,
        });
    return error ? { ok: false, message: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not saved.' };
  }
}

export async function deleteMyText(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { error } = await supabase.from('message_templates').delete().eq('id', id);
    return error ? { ok: false, message: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Not deleted.' };
  }
}
