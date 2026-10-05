import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Card } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { landingRoute } from '@/lib/account';
import { acceptInvite, checkInvite } from '@/lib/employeeInvites';
import { clearRoleCache } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * Where an invited EMPLOYEE lands (2026-10-05): app.dcsolarkc.com/join?code=…
 * from the link an admin sent them from Menu → Employees.
 *
 * Public on purpose — they have no login yet (or forgot their password: the
 * same page serves a reset link). The code is checked by `accept-invite`;
 * they choose a password, the function creates (or updates) their login, and
 * this page signs them in and sends them to their part of the app (a sales
 * rep straight into their CRM).
 */
const MIN_PASSWORD = 10;

type Phase =
  | { kind: 'checking' }
  | { kind: 'bad'; message: string }
  | { kind: 'ready'; name: string | null; email: string; reset: boolean }
  | { kind: 'done' };

export default function JoinScreen() {
  const { code } = useLocalSearchParams<{ code?: string }>();
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!code) {
      setPhase({ kind: 'bad', message: 'This link is not complete. Ask DC Solar for a new one.' });
      return;
    }
    void checkInvite(String(code)).then((result) => {
      if (cancelled) return;
      if (result.ok) setPhase({ kind: 'ready', name: result.name, email: result.email, reset: result.kind === 'reset' });
      else setPhase({ kind: 'bad', message: result.message });
    });
    return () => {
      cancelled = true;
    };
  }, [code]);

  const submit = async () => {
    if (phase.kind !== 'ready' || !code) return;
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await acceptInvite(String(code), password);
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    // Any session already in this browser (an admin testing, say) is not theirs.
    await supabase.auth.signOut().catch(() => {});
    if (result.mfa) {
      // They sign in with a 6-digit code too — the normal sign-in asks for it.
      setBusy(false);
      setPhase({ kind: 'done' });
      return;
    }
    clearRoleCache();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: result.email, password });
    if (signInError) {
      setBusy(false);
      setPhase({ kind: 'done' });
      return;
    }
    router.replace((await landingRoute()) as never);
  };

  return (
    <SafeAreaView style={styles.safe}>
      <Stack.Screen options={{ title: 'DC Solar', headerShown: false }} />
      <View style={styles.center}>
        <Card style={styles.card}>
          <Ionicons name="sunny" size={36} color={colors.sun} />
          {phase.kind === 'checking' ? (
            <ActivityIndicator color={colors.ocean} />
          ) : phase.kind === 'bad' ? (
            <>
              <AppText variant="title" align="center">
                This link does not work
              </AppText>
              <AppText variant="body" align="center" color={colors.textSecondary}>
                {phase.message}
              </AppText>
            </>
          ) : phase.kind === 'done' ? (
            <>
              <AppText variant="title" align="center">
                Your password is set
              </AppText>
              <AppText variant="body" align="center" color={colors.textSecondary}>
                Sign in with your email and the password you just chose.
              </AppText>
              <Pressable onPress={() => router.replace('/' as never)} style={({ pressed }) => [styles.button, pressed && styles.dim]}>
                <Text style={styles.buttonText}>Go to sign in</Text>
              </Pressable>
            </>
          ) : (
            <>
              <AppText variant="title" align="center">
                {phase.reset ? 'Set a new password' : `Welcome to DC Solar${phase.name ? `, ${phase.name.split(' ')[0]}` : ''}`}
              </AppText>
              <AppText variant="body" align="center" color={colors.textSecondary}>
                {phase.reset ? 'Choose a new password for ' : 'Choose a password to finish setting up '}
                <Text style={styles.email}>{phase.email}</Text>.
              </AppText>
              <TextInput
                value={password}
                onChangeText={(v) => {
                  setPassword(v);
                  setError(null);
                }}
                placeholder={`Password (at least ${MIN_PASSWORD} characters)`}
                placeholderTextColor={colors.inkSoft}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="new-password"
                style={styles.input}
              />
              <TextInput
                value={confirm}
                onChangeText={(v) => {
                  setConfirm(v);
                  setError(null);
                }}
                placeholder="Type it again"
                placeholderTextColor={colors.inkSoft}
                secureTextEntry
                autoCapitalize="none"
                autoComplete="new-password"
                onSubmitEditing={() => void submit()}
                style={styles.input}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Pressable onPress={() => void submit()} disabled={busy} style={({ pressed }) => [styles.button, (pressed || busy) && styles.dim]}>
                {busy ? (
                  <ActivityIndicator color={colors.textOnAction} />
                ) : (
                  <Text style={styles.buttonText}>{phase.reset ? 'Save new password' : 'Create my account'}</Text>
                )}
              </Pressable>
            </>
          )}
        </Card>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
  card: { maxWidth: 440, width: '100%', alignItems: 'stretch', gap: spacing.md, padding: spacing.xl },
  email: { color: colors.ink, fontWeight: '800' },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 4,
    color: colors.ink,
    fontSize: 15,
  },
  error: { color: colors.danger, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  button: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingVertical: spacing.sm + 4, alignItems: 'center' },
  buttonText: { color: colors.textOnAction, fontSize: 15, fontWeight: '800' },
  dim: { opacity: 0.6 },
});
