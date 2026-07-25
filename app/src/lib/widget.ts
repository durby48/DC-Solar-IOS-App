/**
 * Home-screen widget bridge — pushes today's job + clock state into the
 * App Group shared storage that the WidgetKit target (targets/widget) reads.
 * iOS-only: everywhere else (web, Android, Expo Go) this is a silent no-op,
 * so callers never need to guard.
 */

import { Platform } from 'react-native';

const APP_GROUP = 'group.com.dcsolarkc.fieldapp';
const STATE_KEY = 'widgetState';

export interface WidgetState {
  jobName: string;
  jobNumber: string;
  address: string;
  /** Clock-in time in ms since epoch; 0 when off the clock. */
  clockInAt: number;
  /** Seconds already worked today across completed punches. */
  todaySeconds: number;
}

export function updateWidgetState(state: WidgetState): void {
  if (Platform.OS !== 'ios') return;
  try {
    // Lazy require: the module touches native globals at import time, which
    // only exist in a real iOS build (not web bundles or Expo Go).
    const { ExtensionStorage } =
      require('@bacons/apple-targets') as typeof import('@bacons/apple-targets');
    const storage = new ExtensionStorage(APP_GROUP);
    storage.set(STATE_KEY, {
      jobName: state.jobName,
      jobNumber: state.jobNumber,
      address: state.address,
      clockInAt: state.clockInAt,
      todaySeconds: Math.round(state.todaySeconds),
    });
    ExtensionStorage.reloadWidget();
  } catch {
    // Widget data is best-effort — never let it break the app.
  }
}
