/**
 * iOS/Android: the phone's address book through `expo-contacts/legacy`.
 *
 * WHY THE LEGACY ENTRY POINT. SDK 57's `expo-contacts` root export keeps
 * `getContactsAsync` as a stub that THROWS at runtime ("import from
 * expo-contacts/legacy"); the new `Contact.getAll()` class API returns
 * lazy objects that need a second call per contact for details. The legacy
 * function returns plain, paged data with the fields asked for — exactly the
 * shape a "tick the ones you want" list needs.
 *
 * PAGED, NEVER ONE BIG READ. `pageSize` 200 in a loop: a 4,000-entry address
 * book comes over in twenty small hops the UI can show progress for, and a
 * hard cap stops a runaway loop on a phone that keeps saying "more".
 *
 * Types are re-exported from `./deviceContacts` (the web file) so both
 * implementations share one contract.
 */

import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

import type { DeviceContact, DeviceContactsResult } from './deviceContacts';

export type { DeviceContact, DeviceContactsResult } from './deviceContacts';

type Legacy = typeof import('expo-contacts/legacy');

const PAGE_SIZE = 200;
/** 50 pages × 200 — nobody has more, and a loop that never ends is worse. */
const MAX_CONTACTS = 10_000;

let legacy: Legacy | null = null;

function loadLegacy(): Legacy | null {
  if (legacy) return legacy;
  if (Platform.OS === 'web') return null;
  // Ask for the native module WITHOUT evaluating the package first. Build 32
  // excludes expo-contacts from autolinking (HANDOFF: its framework links
  // Testing.framework), and evaluating `expo-contacts/legacy` on a binary
  // without it runs `requireNativeModule('ExpoContacts')` and
  // `requireNativeView('ExpoContactAccessButton')` at module load — that
  // crashed the app the moment Phone → Contacts mounted.
  if (!requireOptionalNativeModule('ExpoContacts')) return null;
  try {
    // Static require, resolved at bundle time; wrapped so a binary without
    // the native module surfaces as "unsupported".
    legacy = require('expo-contacts/legacy') as Legacy;
    return legacy;
  } catch {
    return null;
  }
}

export function deviceContactsSupported(): boolean {
  return loadLegacy() !== null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Prefer the number the phone marks primary, then card order; de-duplicated. */
function numbersOf(raw: readonly { number?: string; isPrimary?: boolean }[] | undefined): string[] {
  const list = [...(raw ?? [])].sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1));
  const out: string[] = [];
  for (const entry of list) {
    const value = clean(entry.number);
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function emailsOf(raw: readonly { email?: string; isPrimary?: boolean }[] | undefined): string[] {
  const list = [...(raw ?? [])].sort((a, b) => (a.isPrimary === b.isPrimary ? 0 : a.isPrimary ? -1 : 1));
  const out: string[] = [];
  for (const entry of list) {
    const value = clean(entry.email)?.toLowerCase() ?? null;
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

export async function readDeviceContacts(): Promise<DeviceContactsResult> {
  const mod = loadLegacy();
  if (!mod) return { status: 'unsupported' };
  try {
    const permission = await mod.requestPermissionsAsync();
    if (permission.status !== 'granted') return { status: 'denied' };

    const fields = [
      mod.Fields.ID,
      mod.Fields.Name,
      mod.Fields.FirstName,
      mod.Fields.LastName,
      mod.Fields.PhoneNumbers,
      mod.Fields.Emails,
      mod.Fields.Company,
      mod.Fields.JobTitle,
    ];

    const contacts: DeviceContact[] = [];
    const seen = new Set<string>();
    let pageOffset = 0;
    for (;;) {
      const page = await mod.getContactsAsync({ fields, pageSize: PAGE_SIZE, pageOffset });
      for (const raw of page.data) {
        const id = clean(raw.id) ?? '';
        if (!id || seen.has(id)) continue;
        seen.add(id);
        const org = clean(raw.company);
        const name =
          clean(raw.name) ??
          clean([raw.firstName, raw.lastName].filter(Boolean).join(' ')) ??
          org ??
          '';
        if (!name) continue;
        contacts.push({
          id,
          name,
          org,
          title: clean(raw.jobTitle),
          phones: numbersOf(raw.phoneNumbers),
          emails: emailsOf(raw.emails),
        });
      }
      if (!page.hasNextPage || page.data.length === 0 || contacts.length >= MAX_CONTACTS) break;
      pageOffset += page.data.length;
    }

    contacts.sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }));
    return { status: 'ok', contacts };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : 'Could not read your contacts.' };
  }
}
