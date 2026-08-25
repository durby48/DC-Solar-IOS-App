import Ionicons from '@expo/vector-icons/Ionicons';
import * as Clipboard from 'expo-clipboard';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Image, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Screen,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import {
  confirmEnrollment,
  listFactors,
  removeFactor,
  startEnrollment,
  type EnrollmentStart,
  type MfaFactor,
} from '@/lib/mfa';
import {
  fetchMySessions,
  formatLastSeen,
  revokeOtherSessions,
  revokeSession,
  type DeviceSession,
} from '@/lib/sessions';

/**
 * Two-factor setup for staff (More → Security).
 *
 * The QR is rendered on web, where an SVG data URI works in an <img>. On the
 * phone the setup key is shown instead and can be copied — most people are
 * enrolling ON the phone that holds the authenticator, where there's nothing
 * to scan anyway. Both paths produce the same factor.
 */
export default function SecurityScreen() {
  const [factors, setFactors] = useState<MfaFactor[]>([]);
  const [loading, setLoading] = useState(true);
  const [setup, setSetup] = useState<EnrollmentStart | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);
  const [devices, setDevices] = useState<DeviceSession[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  /** Session id currently being signed out, so only that row shows a spinner. */
  const [revoking, setRevoking] = useState<string | null>(null);

  const loadDevices = useCallback(async () => {
    setDevices(await fetchMySessions());
    setDevicesLoading(false);
  }, []);

  const load = useCallback(async () => {
    setFactors(await listFactors());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    void loadDevices();
  }, [load, loadDevices]);

  const active = factors.find((f) => f.status === 'verified') ?? null;

  const signOutDevice = async (session: DeviceSession) => {
    setRevoking(session.id);
    const ok = await revokeSession(session.id);
    setRevoking(null);
    if (ok) {
      haptics.success();
      setDevices((list) => list.filter((d) => d.id !== session.id));
    } else {
      setStatus({ kind: 'error', message: 'Could not sign that device out. Try again.' });
    }
  };

  const signOutOthers = async () => {
    setRevoking('others');
    const removed = await revokeOtherSessions();
    setRevoking(null);
    if (removed === null) {
      setStatus({ kind: 'error', message: 'Could not sign the other devices out.' });
      return;
    }
    haptics.success();
    setStatus({
      kind: 'success',
      message:
        removed === 0
          ? 'No other devices were signed in.'
          : `Signed out ${removed} other device${removed === 1 ? '' : 's'}.`,
    });
    void loadDevices();
  };

  const begin = async () => {
    setBusy(true);
    setStatus(null);
    const result = await startEnrollment();
    setBusy(false);
    if (result.ok) setSetup(result.value);
    else setStatus({ kind: 'error', message: result.message });
  };

  const confirm = async () => {
    if (!setup) return;
    setBusy(true);
    setStatus(null);
    const result = await confirmEnrollment(setup.factorId, code);
    setBusy(false);
    if (result.ok) {
      setSetup(null);
      setCode('');
      haptics.success();
      setStatus({ kind: 'success', message: 'Two-factor authentication is on.' });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  const turnOff = async (factorId: string) => {
    setBusy(true);
    setStatus(null);
    const result = await removeFactor(factorId);
    setBusy(false);
    if (result.ok) {
      haptics.warn();
      setStatus({ kind: 'success', message: 'Two-factor authentication is off.' });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  /**
   * Copy the setup key. `expo-clipboard` ships in build 29, so this now works
   * on the phone as well as the browser — which matters, because the phone is
   * where most people enrol (the authenticator is on the same device, so
   * there is no QR to scan). The key stays `selectable` regardless: if the
   * clipboard is blocked (an insecure browser context, a locked-down device)
   * a long-press still gets it, so this button can only ever add.
   */
  const copyKey = async () => {
    if (!setup) return;
    try {
      await Clipboard.setStringAsync(setup.secret);
      haptics.success();
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable: the key is selectable anyway.
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Security' }} />
      <Screen edges={[]} contentContainerStyle={styles.container}>
        <AppText variant="title">Two-factor authentication</AppText>
        <AppText variant="body" color={colors.textSecondary}>
          Adds a 6-digit code from an authenticator app on top of your password. You&apos;ll
          enter it once per device — after that the device stays trusted until you sign out.
        </AppText>

        {loading ? (
          <SkeletonList count={1} height={96} />
        ) : active ? (
          <Card style={styles.card}>
            <View style={styles.onRow}>
              <Ionicons name="shield-checkmark" size={22} color={colors.success} />
              <View style={styles.onText}>
                <AppText variant="bodyStrong">Two-factor is ON</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  {active.friendlyName ?? 'Authenticator app'}
                </AppText>
              </View>
            </View>
            <Button
              label="Turn off"
              variant="danger"
              fullWidth
              loading={busy}
              haptic="warn"
              onPress={() => void turnOff(active.id)}
            />
          </Card>
        ) : setup ? (
          <Card style={styles.card}>
            <AppText variant="section" color={colors.accentPrimary} style={styles.step}>
              1. Add this to your authenticator app
            </AppText>
            {Platform.OS === 'web' && setup.qrCode ? (
              <Image source={{ uri: setup.qrCode }} style={styles.qr} resizeMode="contain" />
            ) : null}
            <AppText variant="section" color={colors.accentPrimary} style={styles.step}>
              {Platform.OS === 'web' ? 'Or enter this key by hand:' : 'Enter this setup key:'}
            </AppText>
            <AnimatedPressable
              onPress={copyKey}
              haptic="tapLight"
              scaleTo={0.99}
              accessibilityRole="button"
              accessibilityLabel="Copy the setup key"
              style={styles.keyBox}>
              {/* Stays a bare Text: `selectable` is the fallback when the
                  clipboard is unavailable, and AppText has no such prop. */}
              <Text style={styles.keyText} selectable>
                {setup.secret}
              </Text>
              <View style={styles.keyHintRow}>
                <Ionicons
                  name={copied ? 'checkmark-circle' : 'copy-outline'}
                  size={13}
                  color={copied ? colors.success : colors.textMuted}
                />
                <AppText
                  variant="caption"
                  color={copied ? colors.success : colors.textMuted}>
                  {copied ? 'Copied' : 'Tap to copy — or press and hold the key'}
                </AppText>
              </View>
            </AnimatedPressable>

            <AppText variant="section" color={colors.accentPrimary} style={styles.step}>
              2. Enter the 6-digit code it shows
            </AppText>
            <TextInput
              style={styles.codeInput}
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              placeholderTextColor={colors.textMuted}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />
            <View style={styles.buttonRow}>
              <Button
                label="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => setSetup(null)}
              />
              <Button
                label="Turn on"
                disabled={code.length < 6}
                loading={busy}
                onPress={confirm}
              />
            </View>
          </Card>
        ) : (
          <Button
            label="Set up two-factor"
            icon="shield-checkmark"
            size="lg"
            loading={busy}
            onPress={begin}
          />
        )}

        {status ? (
          <AppText
            variant="caption"
            color={status.kind === 'error' ? colors.danger : colors.success}>
            {status.message}
          </AppText>
        ) : null}

        <AppText variant="caption" color={colors.textMuted} style={styles.footnote}>
          Lost your authenticator? Devon can clear it from the office — you&apos;ll sign in with
          just your password and can set it up again.
        </AppText>

        {/* ---- signed-in devices ---- */}
        <AppText variant="title" style={styles.sectionTop}>
          Signed-in devices
        </AppText>
        <AppText variant="body" color={colors.textSecondary}>
          Everywhere your account is currently signed in. Only your own devices are listed —
          nobody else&apos;s, and nobody can see yours.
        </AppText>

        {devicesLoading ? (
          <SkeletonList count={2} height={64} />
        ) : devices.length === 0 ? (
          <Card style={styles.card}>
            <AppText variant="body" color={colors.textMuted}>
              No other sessions found. If this looks wrong, pull down to refresh or sign out and
              back in.
            </AppText>
          </Card>
        ) : (
          <Card padded={false} style={styles.card}>
            {devices.map((device, i) => (
              <View
                key={device.id}
                style={[styles.deviceRow, i < devices.length - 1 && styles.deviceDivider]}>
                <Ionicons
                  name={device.icon}
                  size={20}
                  color={device.isCurrent ? colors.success : colors.textMuted}
                />
                <View style={styles.deviceText}>
                  <View style={styles.deviceTitleRow}>
                    <AppText variant="bodyStrong">{device.label}</AppText>
                    {device.isCurrent ? (
                      <View style={styles.thisDevice}>
                        <AppText variant="caption" color={colors.success}>
                          This device
                        </AppText>
                      </View>
                    ) : null}
                  </View>
                  <AppText variant="caption" color={colors.textMuted}>
                    {`Last used ${formatLastSeen(device.lastSeenAt)}`}
                    {device.ip ? ` · ${device.ip}` : ''}
                    {device.aal === 'aal2' ? ' · 2FA' : ''}
                  </AppText>
                </View>
                {device.isCurrent ? null : (
                  <Button
                    label="Sign out"
                    variant="ghost"
                    size="sm"
                    loading={revoking === device.id}
                    haptic="warn"
                    onPress={() => void signOutDevice(device)}
                  />
                )}
              </View>
            ))}
          </Card>
        )}

        {devices.some((d) => !d.isCurrent) ? (
          <Button
            label="Sign out all other devices"
            variant="danger"
            fullWidth
            loading={revoking === 'others'}
            haptic="warn"
            onPress={() => void signOutOthers()}
          />
        ) : null}

        <AppText variant="caption" color={colors.textMuted} style={styles.footnote}>
          Signing a device out kills its saved login straight away. It can keep working for up to
          an hour on the token it already holds, then it&apos;s locked out.
        </AppText>
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  container: {
    maxWidth: 520,
    width: '100%',
    alignSelf: 'center',
  },
  card: {
    gap: spacing.sm,
  },
  onRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  onText: {
    flex: 1,
    gap: 1,
  },
  step: {
    marginTop: spacing.xs,
  },
  qr: {
    width: 200,
    height: 200,
    alignSelf: 'center',
    backgroundColor: colors.white,
  },
  keyBox: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.sm + 2,
    gap: spacing.xs,
  },
  keyText: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
    letterSpacing: 1.5,
    ...Platform.select({ ios: { fontFamily: 'Menlo' }, default: { fontFamily: 'monospace' } }),
  },
  keyHintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  codeInput: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 24,
    letterSpacing: 8,
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  footnote: {
    lineHeight: 18,
  },
  sectionTop: {
    marginTop: spacing.lg,
  },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
  },
  deviceDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  deviceText: {
    flex: 1,
    gap: 2,
  },
  deviceTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
  },
  thisDevice: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
});
