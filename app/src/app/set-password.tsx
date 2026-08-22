import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppText, Button, Card, EmptyState, Skeleton } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { landingRoute } from '@/lib/account';
import { haptics } from '@/lib/haptics';
import { supabase } from '@/lib/supabase';

/**
 * Set a permanent password after a temporary-password or invite sign-in.
 *
 * WHY THIS SCREEN KEEPS ITS OWN SHELL rather than using the `Screen`
 * primitive: the form sits inside a `KeyboardAvoidingView`, which has to sit
 * between the safe area and the scroll view — and `Screen` owns both of
 * those. Everything inside is primitives.
 */
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
      haptics.success();
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
          <Skeleton width={280} height={120} />
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
          <Card style={styles.card}>
            <EmptyState
              icon="link-outline"
              title="Link expired"
              body="This link has expired or was already used — ask the office to resend your invitation."
            />
            <Button label="Back to sign in" fullWidth onPress={() => router.replace('/')} />
          </Card>
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
          <AppText variant="title" align="center">
            Create your password
          </AppText>
          <AppText
            variant="body"
            color={colors.textSecondary}
            align="center"
            style={styles.subtitle}>
            You signed in with the shared temporary password. Set a permanent password only you
            know — you&apos;ll use it from now on.
          </AppText>

          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder="New password (8+ characters)"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoCapitalize="none"
              value={password}
              onChangeText={setPassword}
            />
            <TextInput
              style={styles.input}
              placeholder="Confirm new password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              autoCapitalize="none"
              value={confirm}
              onChangeText={setConfirm}
              onSubmitEditing={save}
            />

            {error ? (
              <AppText variant="caption" color={colors.danger} align="center">
                {error}
              </AppText>
            ) : null}

            <Button label="Save password" size="lg" fullWidth loading={loading} onPress={save} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: colors.surfaceAlt,
  },
  flex: {
    flex: 1,
  },
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  card: {
    width: '100%',
    maxWidth: 400,
    gap: spacing.sm,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  subtitle: {
    maxWidth: 400,
    marginBottom: spacing.md,
  },
  form: {
    width: '100%',
    maxWidth: 400,
    gap: spacing.md,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    fontSize: 16,
    color: colors.textPrimary,
  },
});
