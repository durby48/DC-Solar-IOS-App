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

  const load = useCallback(async () => {
    setFactors(await listFactors());
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const active = factors.find((f) => f.status === 'verified') ?? null;

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
});
