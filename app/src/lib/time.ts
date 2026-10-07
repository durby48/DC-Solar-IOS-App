/** Time-of-day helpers for schedule dates (HH:MM[:SS] strings). */

/** "07:00:00" (or "07:00") -> "7:00 AM". Returns null for null/invalid input. */
export function formatTimeLabel(time: string | null | undefined): string | null {
  if (!time) return null;
  const match = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!match) return null;
  let hours = Number(match[1]);
  const minutes = match[2];
  if (hours > 23) return null;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
}

/**
 * Read a typed time (2026-10-08): "2:30 pm", "2:30pm", "230pm", "2pm", "14:30",
 * "9" (9 AM; 1–6 alone read as PM — nobody books 3 in the morning) →
 * "HH:MM" 24h, or null when it is not a time.
 */
export function parseTimeInput(text: string): string | null {
  const t = text.trim().toLowerCase().replace(/\s+/g, '').replace(/\./g, '');
  const m = /^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.[0];
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'p' && h !== 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  } else {
    if (h > 23) return null;
    if (h >= 1 && h <= 6) h += 12;
  }
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Validate a YYYY-MM-DD string (real calendar date). */
export function isValidISODate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/** Validate a 24h HH:MM string. */
export function isValidHHMM(value: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(':').map(Number);
  return h >= 0 && h <= 23 && m >= 0 && m <= 59;
}

/** Format a Date's local date part as YYYY-MM-DD. */
export function toISODate(date: Date): string {
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  const d = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** Format a Date's local time part as HH:MM (24h). */
export function toHHMM(date: Date): string {
  const h = `${date.getHours()}`.padStart(2, '0');
  const m = `${date.getMinutes()}`.padStart(2, '0');
  return `${h}:${m}`;
}
