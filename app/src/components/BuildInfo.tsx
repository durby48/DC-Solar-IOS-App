import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, spacing } from '@/constants/theme';

/**
 * Footer for the More screen: which app version and which over-the-air update
 * this device is actually running.
 *
 * Why it exists: HANDOFF records that OTA adoption on build 27 was never
 * proven, because there was no way to look at a phone and know which update
 * it had. This line — plus a tap-to-check — turns every OTA into its own
 * proof: publish, relaunch, and the short update id here should change.
 *
 * Reads only expo-updates / expo-constants; no network unless the user taps.
 * Degrades: Expo Go, dev, and web all report "development build" or "web build"
 * because expo-updates is disabled there.
 */

function shortId(id: string | null | undefined): string {
  if (!id) return '';
  return id.replace(/-/g, '').slice(0, 8);
}

function formatWhen(d: Date | null | undefined): string {
  if (!d) return '';
  try {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

export default function BuildInfo() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const version = Constants.expoConfig?.version ?? '?';
  // Native reports the real runtime; web/dev report '' or a policy object —
  // the appVersion policy means runtime === version, so fall back to that.
  const runtime = Updates.runtimeVersion || Constants.expoConfig?.runtimeVersion;
  const runtimeText = typeof runtime === 'string' && runtime ? runtime : version;

  const updatesLive = Updates.isEnabled && !__DEV__ && Platform.OS !== 'web';

  let updateLine: string;
  if (Platform.OS === 'web') {
    updateLine = 'web build';
  } else if (!updatesLive) {
    updateLine = 'development build';
  } else if (Updates.isEmbeddedLaunch || !Updates.updateId) {
    updateLine = 'embedded bundle (no OTA applied yet)';
  } else {
    const when = formatWhen(Updates.createdAt);
    updateLine = `update ${shortId(Updates.updateId)}${when ? ` · ${when}` : ''}`;
  }

  const channel = Updates.channel ? ` · ${Updates.channel}` : '';

  const checkNow = async () => {
    if (!updatesLive || busy) return;
    setBusy(true);
    setStatus('Checking…');
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        setStatus('Up to date.');
      } else {
        setStatus('Downloading update…');
        await Updates.fetchUpdateAsync();
        setStatus('Restarting…');
        await Updates.reloadAsync();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setStatus(`Could not check: ${msg}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={checkNow}
      disabled={!updatesLive || busy}
      hitSlop={8}
      style={styles.wrap}
      accessibilityRole={updatesLive ? 'button' : 'text'}
      accessibilityLabel="App version and update">
      <Text style={styles.line}>
        DC Solar KC {version} · runtime {runtimeText}
        {channel}
      </Text>
      <Text style={styles.line}>{updateLine}</Text>
      {updatesLive ? (
        <Text style={styles.hint}>{status ?? 'Tap to check for updates'}</Text>
      ) : status ? (
        <Text style={styles.hint}>{status}</Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignSelf: 'center',
    alignItems: 'center',
    paddingVertical: spacing.md,
    gap: 2,
  },
  line: {
    color: colors.inkSoft,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  hint: {
    color: colors.ocean,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
});
