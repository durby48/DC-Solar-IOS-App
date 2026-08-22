import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { landingRoute } from '@/lib/account';
import { supabase } from '@/lib/supabase';

export default function SetPasswordScreen() {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Is there actually a session to set a password ON? Invite and recovery
  // links are single-use and expire, so this screen is regularly opened with
  // nothing behind it. `null` = still deciding.
  const [hasSession, setHasSession] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    // On web the session comes out of the `#access_token=` fragment that
    // supabase-js parses at startup (`detectSessionInUrl`); `getSession()`
    // waits for that to finish, so this is a real answer, not a race.
    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setHasSession(Boolean(data.session));
    });
    // Belt and braces: if a session lands a beat later (slow storage read,
    // token refresh), never leave someone staring at "expired" with a
    // perfectly good link.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session && !cancelled) setHasSession(true);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const save = async () => {
    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password === 'DCSolarKC2026') {
      setError('Please pick a new password of your own.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
        data: { must_change_password: false },
      });
      if (updateError) {
        setError(updateError.message);
        return;
      }
      // Staff land in the crew tabs, invited customers in the portal.
      router.replace(await landingRoute());
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setLoading(false);
    }
  };

  if (hasSession === null) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centre}>
          <ActivityIndicator color={colors.ink} />
        </View>
      </SafeAreaView>
    );
  }

  // No session behind the link. Say so plainly and give them the one action
  // that helps — going back to sign in — rather than a form that can only fail.
  if (!hasSession) {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.card}>
            <Text style={styles.title}>Link expired</Text>
            <Text style={styles.subtitle}>
              This link has expired or was already used — ask the office to
              resend your invitation.
            </Text>
            <Pressable
              style={({ pressed }) => [
                styles.button,
                styles.cardButton,
                pressed && styles.pressed,
              ]}
              onPress={() => router.replace('/')}>
              <Text style={styles.buttonText}>Back to sign in</Text>
            </Pressable>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Create your password</Text>
          <Text style={styles.subtitle}>
            You signed in with the shared temporary password. Set a permanent
            password only you know — you&apos;ll use it from now on.
          </Text>

          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder="New password (8+ characters)"
              placeholderTextColor={colors.inkSoft}
              secureTextEntry
              autoCapitalize="none"
              value={password}
              onChangeText={setPassword}
            />
            <TextInput
              style={styles.input}
              placeholder="Confirm new password"
              placeholderTextColor={colors.inkSoft}
              secureTextEntry
              autoCapitalize="none"
              value={confirm}
              onChangeText={setConfirm}
              onSubmitEditing={save}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              onPress={save}
              disabled={loading}>
              {loading ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Text style={styles.buttonText}>Save password</Text>
              )}
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  flex: {
    flex: 1,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.tan,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: 'center',
    ...shadows.card,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  title: {
    color: colors.ink,
    fontSize: 24,
    fontWeight: '800',
  },
  subtitle: {
    color: colors.inkSoft,
    fontSize: 15,
    textAlign: 'center',
    maxWidth: 400,
    marginBottom: spacing.md,
  },
  form: {
    width: '100%',
    maxWidth: 400,
    gap: spacing.md,
  },
  input: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.tan,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    fontSize: 16,
    color: colors.ink,
  },
  error: {
    color: colors.danger,
    fontSize: 14,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.sun,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    ...shadows.card,
  },
  cardButton: {
    alignSelf: 'stretch',
    paddingHorizontal: spacing.lg,
  },
  pressed: {
    opacity: 0.8,
  },
  buttonText: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
  },
});
