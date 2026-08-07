import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
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
      setStatus({ kind: 'success', message: 'Two-factor authentication is off.' });
      await load();
    } else {
      setStatus({ kind: 'error', message: result.message });
    }
  };

  /**
   * Web copies to the clipboard; on the phone the key is `selectable` so a
   * long-press copies it. `expo-clipboard` is NOT installed and adding it
   * would force a full App Store build for one convenience button.
   */
  const copyKey = async () => {
    if (!setup) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(setup.secret);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard blocked (insecure context): the key is selectable anyway.
      }
    }
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Security' }} />
      <ScrollView style={styles.safe} contentContainerStyle={styles.container}>
        <Text style={styles.heading}>Two-factor authentication</Text>
        <Text style={styles.body}>
          Adds a 6-digit code from an authenticator app on top of your password. You&apos;ll
          enter it once per device — after that the device stays trusted until you sign out.
        </Text>

        {loading ? (
          <ActivityIndicator color={colors.ocean} />
        ) : active ? (
          <View style={styles.card}>
            <View style={styles.onRow}>
              <Ionicons name="shield-checkmark" size={22} color={colors.success} />
              <View style={styles.onText}>
                <Text style={styles.onTitle}>Two-factor is ON</Text>
                <Text style={styles.onBody}>{active.friendlyName ?? 'Authenticator app'}</Text>
              </View>
            </View>
            <Pressable
              onPress={() => void turnOff(active.id)}
              disabled={busy}
              style={({ pressed }) => [styles.outlineDanger, pressed && styles.pressed]}>
              {busy ? (
                <ActivityIndicator color={colors.danger} />
              ) : (
                <Text style={styles.outlineDangerText}>Turn off</Text>
              )}
            </Pressable>
          </View>
        ) : setup ? (
          <View style={styles.card}>
            <Text style={styles.step}>1. Add this to your authenticator app</Text>
            {Platform.OS === 'web' && setup.qrCode ? (
              <Image source={{ uri: setup.qrCode }} style={styles.qr} resizeMode="contain" />
            ) : null}
            <Text style={styles.step}>
              {Platform.OS === 'web' ? 'Or enter this key by hand:' : 'Enter this setup key:'}
            </Text>
            <Pressable onPress={copyKey} style={({ pressed }) => [styles.keyBox, pressed && styles.pressed]}>
              <Text style={styles.keyText} selectable>
                {setup.secret}
              </Text>
              <Text style={styles.keyHint}>
                {copied
                  ? 'Copied'
                  : Platform.OS === 'web'
                    ? 'Tap to copy'
                    : 'Press and hold to copy'}
              </Text>
            </Pressable>

            <Text style={styles.step}>2. Enter the 6-digit code it shows</Text>
            <TextInput
              style={styles.codeInput}
              value={code}
              onChangeText={setCode}
              placeholder="000000"
              placeholderTextColor={colors.inkSoft}
              keyboardType="number-pad"
              maxLength={6}
              autoFocus
            />
            <View style={styles.buttonRow}>
              <Pressable onPress={() => setSetup(null)} disabled={busy} hitSlop={8}>
                <Text style={styles.cancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={confirm}
                disabled={busy || code.length < 6}
                style={({ pressed }) => [
                  styles.primary,
                  (busy || code.length < 6) && styles.disabled,
                  pressed && styles.pressed,
                ]}>
                {busy ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <Text style={styles.primaryText}>Turn on</Text>
                )}
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={begin}
            disabled={busy}
            style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
            {busy ? (
              <ActivityIndicator color={colors.ink} />
            ) : (
              <Text style={styles.primaryText}>Set up two-factor</Text>
            )}
          </Pressable>
        )}

        {status ? (
          <Text style={status.kind === 'error' ? styles.error : styles.success}>
            {status.message}
          </Text>
        ) : null}

        <Text style={styles.footnote}>
          Lost your authenticator? Devon can clear it from the office — you&apos;ll sign in with
          just your password and can set it up again.
        </Text>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  container: { padding: spacing.lg, gap: spacing.md, maxWidth: 520, width: '100%', alignSelf: 'center' },
  heading: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  body: { color: colors.inkSoft, fontSize: 14, lineHeight: 21 },
  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  onRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  onText: { flex: 1 },
  onTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  onBody: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  step: { color: colors.ink, fontSize: 13, fontWeight: '800', marginTop: spacing.xs },
  qr: { width: 200, height: 200, alignSelf: 'center', backgroundColor: colors.white },
  keyBox: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.sm + 2,
    gap: 2,
  },
  keyText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 1.5,
    ...Platform.select({ ios: { fontFamily: 'Menlo' }, default: { fontFamily: 'monospace' } }),
  },
  keyHint: { color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  codeInput: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 8,
    textAlign: 'center',
  },
  buttonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
  },
  primary: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    ...shadows.card,
  },
  primaryText: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.5 },
  outlineDanger: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center',
  },
  outlineDangerText: { color: colors.danger, fontSize: 14, fontWeight: '800' },
  cancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.8 },
  error: { color: colors.danger, fontSize: 13, fontWeight: '600' },
  success: { color: colors.success, fontSize: 13, fontWeight: '700' },
  footnote: { color: colors.inkSoft, fontSize: 12, lineHeight: 18 },
});
