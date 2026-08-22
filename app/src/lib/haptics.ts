import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Haptic feedback, wrapped so a call site never has to think about it.
 *
 * Three promises, in order of how much they matter:
 *
 *   1. NOTHING HERE EVER THROWS. Haptics fail for boring reasons — an iPad
 *      with no Taptic Engine, an Android device with vibration disabled, a
 *      browser. A clock-in must not fail because a phone can't buzz. Every
 *      function swallows its own errors and returns void.
 *   2. Web is a no-op. `expo-haptics` does map onto the Web Vibration API,
 *      but desktop browsers ignore it and mobile Chrome buzzes the whole
 *      phone — neither is the subtle tick these calls mean. app.dcsolarkc.com
 *      is silent by design.
 *   3. Fire and forget. These are deliberately NOT awaited anywhere; the
 *      feedback should land alongside the visual change, not gate it.
 *
 * Vocabulary — keep it small so the app has an accent rather than a stutter:
 *   tapLight   a selection changed (chip, segment, tab)
 *   tapMedium  a real action started (button press that does something)
 *   success    it worked (clocked in, payment recorded, job → Complete)
 *   warn       it worked but look at it (opted-out customer, stale PDF)
 *   error      it failed
 */

const SILENT = Platform.OS === 'web';

function safe(run: () => Promise<unknown>): void {
  if (SILENT) return;
  try {
    void run().catch(() => {
      // A device that can't buzz is not an error worth surfacing.
    });
  } catch {
    // Older platforms can throw synchronously on an unsupported style.
  }
}

/** Selection tick: chips, segments, tab switches, list expands. */
export function tapLight(): void {
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** A button that actually does something: submit, save, navigate-and-act. */
export function tapMedium(): void {
  safe(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
}

/** It worked. Pair with confetti for the big ones, alone for the rest. */
export function success(): void {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** It worked, but there's a caveat the person needs to read. */
export function warn(): void {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}

/** It failed. */
export function error(): void {
  safe(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
}

/** Every haptic, for the rare caller that wants to pick one by name. */
export const haptics = { tapLight, tapMedium, success, warn, error } as const;

/** The names `AnimatedPressable` / `Button` accept in their `haptic` prop. */
export type HapticKind = keyof typeof haptics;
