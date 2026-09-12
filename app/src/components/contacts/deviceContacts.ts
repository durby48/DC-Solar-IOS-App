/**
 * Reading the phone's own address book — the shared contract, and the web
 * answer.
 *
 * TWO FILES, ONE API (the `lib/voice.ts` / `voice.native.ts` pattern):
 *   deviceContacts.native.ts  iOS/Android: `expo-contacts/legacy`, paged.
 *   deviceContacts.ts         this file. TypeScript resolves the import here,
 *                             so the types live here; Metro only reaches it on
 *                             web, where there is no address book to read and
 *                             the import screen says to use the iPhone app.
 *
 * `expo-contacts` is a NATIVE module (config plugin + NSContactsUsageDescription
 * in app.json). 2026-09-12: expo-contacts 57.0.5 links Apple's Swift Testing
 * framework (LC_LOAD_DYLIB @rpath/Testing.framework/Testing), which iPhones
 * do not ship, so build 31 died in dyld before any JS ran. The package stays
 * installed for Metro but is EXCLUDED from native autolinking
 * (package.json expo.autolinking.exclude) until a fixed release; then remove
 * the exclude, re-add the plugin to app.json and bump the runtime. The
 * native file requires it lazily inside a try/catch so an older binary that
 * runs newer JS gets "unsupported", not a red screen.
 */

/** One person from the phone, flattened to what the directory can hold. */
export interface DeviceContact {
  /** The OS identifier — stable per phone/iCloud account; becomes `external_id`. */
  id: string;
  /** Display name as the phone formats it; never empty (falls back to org). */
  name: string;
  org: string | null;
  title: string | null;
  /** Every number on the card, as typed on the phone; the first is preferred. */
  phones: string[];
  emails: string[];
}

export type DeviceContactsResult =
  /**
   * `limited` (iOS 18+): the person chose "Select contacts", so only the ones
   * they shared are visible. More can be shared from Settings.
   */
  | { status: 'ok'; contacts: DeviceContact[]; limited: boolean }
  /**
   * The person said no, or Settings has it off. `canAskAgain` false means iOS
   * will not show the prompt again — only Settings can turn it back on.
   */
  | { status: 'denied'; canAskAgain: boolean }
  /** Web, or a binary without the native module. */
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

/** False on web and on a build without expo-contacts. */
export function deviceContactsSupported(): boolean {
  return false;
}

export async function readDeviceContacts(): Promise<DeviceContactsResult> {
  return { status: 'unsupported' };
}
