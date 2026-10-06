/**
 * Hand a number to the sales Keypad without putting it in the URL (where the
 * web build would keep it in history) — 2026-10-07, Recent calls → an unknown
 * caller opens the Keypad with their number filled in. Set it, navigate to
 * `/keypad`, and the Keypad takes it once when it comes into focus.
 */
let pending: string | null = null;

export function presetDial(phone: string): void {
  pending = phone;
}

export function takePresetDial(): string | null {
  const phone = pending;
  pending = null;
  return phone;
}
