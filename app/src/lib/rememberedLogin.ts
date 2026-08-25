import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Remembering WHO signed in on this device — not the password.
 *
 * Staying signed in is handled elsewhere and is not optional: the Supabase
 * session persists on the device and now survives 30 days of not opening the
 * app (`lib/supabase.ts`, plus the project's session settings). This file only
 * decides whether the email box is pre-filled the next time the form is
 * actually shown — after a sign-out, on a fresh install, or when a session
 * finally lapses.
 *
 * The password is deliberately NOT stored. iOS and Android already have a
 * vetted place for that — the Keychain / password manager — which the login
 * inputs opt into with `textContentType` / `autoComplete`. Rolling our own
 * password store would be strictly worse than the one the OS ships.
 *
 * Every call swallows its own storage errors. A device with a wedged storage
 * layer should still be able to sign somebody in.
 */

const EMAIL_KEY = 'dcsolar.login.email';
const OPT_OUT_KEY = 'dcsolar.login.forget';

/** The email to pre-fill, or null when there is none / the crew opted out. */
export async function loadRememberedEmail(): Promise<string | null> {
  try {
    const [optedOut, email] = await Promise.all([
      AsyncStorage.getItem(OPT_OUT_KEY),
      AsyncStorage.getItem(EMAIL_KEY),
    ]);
    if (optedOut === '1') return null;
    return email && email.trim() ? email : null;
  } catch {
    return null;
  }
}

/** True unless this device has explicitly asked to be forgotten. */
export async function loadRememberPreference(): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(OPT_OUT_KEY)) !== '1';
  } catch {
    // Default ON: the field crew share one habit — open the app and work.
    return true;
  }
}

/** Called after a successful sign-in, with what the toggle was set to. */
export async function saveRememberedEmail(email: string, remember: boolean): Promise<void> {
  try {
    if (remember) {
      await AsyncStorage.multiRemove([OPT_OUT_KEY]);
      await AsyncStorage.setItem(EMAIL_KEY, email.trim());
    } else {
      await AsyncStorage.setItem(OPT_OUT_KEY, '1');
      await AsyncStorage.removeItem(EMAIL_KEY);
    }
  } catch {
    // Pre-filling is a convenience; failing to record it must not block login.
  }
}
