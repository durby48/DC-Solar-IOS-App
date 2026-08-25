import { supabase } from '@/lib/supabase';

/**
 * The devices signed in as YOU (Security screen).
 *
 * Everything here goes through the three SECURITY DEFINER functions added in
 * `2026-08-25_my_sessions.sql`. `auth.sessions` is not reachable with a client
 * key — proven, not assumed: a probe running as `authenticated` is refused by
 * Postgres — so these functions are the only door, and each one filters on
 * `user_id = auth.uid()` internally. Nothing here can show or revoke somebody
 * else's device, including for an admin.
 */

export interface DeviceSession {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  /** Raw UA string, kept so the detail line can show it verbatim. */
  userAgent: string | null;
  ip: string | null;
  /** 'aal2' when a second factor was used to reach this session. */
  aal: string | null;
  /** The device making this request. */
  isCurrent: boolean;
  /** Human label derived from the user agent. */
  label: string;
  /** Ionicons name for the row. */
  icon: 'phone-portrait' | 'laptop' | 'globe' | 'terminal';
}

/**
 * Turn a user agent into something a solar installer can recognise.
 *
 * Written against the strings actually in this project's `auth.sessions`, not
 * from a generic UA library:
 *
 *   DCSolarKC/29 CFNetwork/3860.700.1 Darwin/25.6.0   → the iOS app, build 29
 *   Mozilla/5.0 (Windows NT 10.0 …) Chrome/138.0.0    → desktop browser
 *   curl/8.21.0, WindowsPowerShell/5.1…               → a script (ours)
 *
 * The build number in the app's UA is genuinely useful: it is how you spot a
 * phone still sitting on an old build.
 */
export function describeDevice(ua: string | null): Pick<DeviceSession, 'label' | 'icon'> {
  if (!ua) return { label: 'Unknown device', icon: 'globe' };

  const app = ua.match(/DCSolarKC\/(\d+)/);
  if (app) {
    const apple = /Darwin|CFNetwork/i.test(ua);
    return {
      label: `DC Solar app · build ${app[1]}${apple ? ' · iPhone' : ''}`,
      icon: 'phone-portrait',
    };
  }

  if (/curl\//i.test(ua) || /PowerShell/i.test(ua) || /python|node-fetch|okhttp/i.test(ua)) {
    return { label: 'Script or command line', icon: 'terminal' };
  }

  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : null;

  const os =
    /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : null;

  if (browser || os) {
    const mobile = os === 'iPhone' || os === 'iPad' || os === 'Android';
    return {
      label: [browser, os].filter(Boolean).join(' on ') || 'Web browser',
      icon: mobile ? 'phone-portrait' : 'laptop',
    };
  }

  return { label: 'Unknown device', icon: 'globe' };
}

/** Short "when" for a row: Just now / 14 min ago / 3 days ago / a date. */
export function formatLastSeen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(then).toLocaleDateString();
}

interface SessionRow {
  id: string;
  created_at: string;
  last_seen_at: string;
  user_agent: string | null;
  ip: string | null;
  aal: string | null;
  is_current: boolean;
}

/** Every device signed in as the current user, most recent first. */
export async function fetchMySessions(): Promise<DeviceSession[]> {
  try {
    const { data, error } = await supabase.rpc('my_sessions');
    if (error || !data) return [];
    return (data as SessionRow[]).map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      userAgent: row.user_agent,
      ip: row.ip,
      aal: row.aal,
      isCurrent: row.is_current,
      ...describeDevice(row.user_agent),
    }));
  } catch {
    // Function missing (migration not applied yet) or offline. The screen
    // shows its empty state rather than an error the crew can't act on.
    return [];
  }
}

/** Sign one device out. Returns false if the id was not one of ours. */
export async function revokeSession(id: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('revoke_my_session', { target: id });
    return !error && data === true;
  } catch {
    return false;
  }
}

/** Sign out everywhere except this device. Returns how many were removed. */
export async function revokeOtherSessions(): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc('revoke_my_other_sessions');
    if (error || typeof data !== 'number') return null;
    return data;
  } catch {
    return null;
  }
}
