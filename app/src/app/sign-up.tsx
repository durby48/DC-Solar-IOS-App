import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AuthProviderButtons from '@/components/AuthProviderButtons';
import { AnimatedPressable, AppText, Button } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { landingRoute, signUpCustomer } from '@/lib/account';
import { haptics } from '@/lib/haptics';
import type { OAuthResult } from '@/lib/oauth';

/**
 * Customer self-signup.
 *
 * Every account created here is a CUSTOMER. Staff access is only ever granted
 * by Devon or Isaiah adding a row to `employees` — which no client key can do,
 * because that table has RLS on and no write policies at all.
 *
 * That holds for the Google and Apple buttons too (2026-08-22): a social
 * account created here is a customer account like any other, and staff are
 * refused twice over. Server-side, `2026-08-22_oauth_staff_block.sql` puts a
 * BEFORE INSERT trigger on `auth.identities` — the table GoTrue writes when it
 * auto-links a Google login to an existing verified account without ever
 * touching `auth.users` — plus a matching check in `handle_new_auth_user()`
 * for brand-new accounts. Client-side, `lib/oauth.ts` re-checks the account
 * kind after every social sign-in and signs an employee straight back out.
 * The staff login screen (`app/index.tsx`) shows no social buttons at all.
 *
 * The password rules shown are the ones Supabase actually enforces; the server
 * is the authority, this text is just so people aren't guessing.
 *
 * WHY THIS SCREEN KEEPS ITS OWN SHELL rather than using the `Screen`
 * primitive: the form has to sit inside a `KeyboardAvoidingView`, which has
 * to sit between the safe area and the scroll view. `Screen` owns both of
 * those, so there is nowhere to put it. Everything inside is primitives.
 */
export default function SignUpScreen() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  /**
   * Outcome of a Google / Apple tap. `cancelled` covers both the user backing
   * out of the sheet and — on web — the page already navigating to the
   * provider, so it must do nothing at all.
   */
  const handleSocialResult = async (result: OAuthResult) => {
    if (result.ok === 'cancelled') return;
    if (result.ok) {
      setError(null);
      haptics.success();
      router.replace(await landingRoute());
      return;
    }
    setError(result.message);
  };

  const submit = async () => {
    if (!fullName.trim() || !email.trim() || !password) {
      setError('Fill in your name, email and a password.');
      return;
    }
    setLoading(true);
    setError(null);
    const result = await signUpCustomer({ fullName, email, password });
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    haptics.success();
    if (result.needsConfirmation) setSent(true);
    else router.replace('/customer');
  };

  if (sent) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <AppText variant="display" align="center">
            Check your email
          </AppText>
          <AppText variant="body" color={colors.textSecondary} align="center">
            We sent a confirmation link to {email.trim()}. Open it to finish creating your
            account, then come back and sign in.
          </AppText>
          <Button label="Back to sign in" fullWidth onPress={() => router.replace('/')} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
          <AppText variant="display">Create your account</AppText>
          <AppText variant="body" color={colors.textSecondary} style={styles.body}>
            For DC Solar customers. Crew accounts are set up by the office — if you work here,
            ask Devon or Isaiah instead of signing up.
          </AppText>

          {/* Renders nothing until the Google client ids are configured. */}
          <AuthProviderButtons
            onResult={(result) => {
              void handleSocialResult(result);
            }}
            disabled={loading}
          />

          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder="Full name"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="words"
              value={fullName}
              onChangeText={setFullName}
            />
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={submit}
            />
            <AppText variant="caption" color={colors.textMuted} style={styles.rules}>
              At least 10 characters, with an uppercase letter, a lowercase letter and a number.
              Passwords found in known data breaches are rejected.
            </AppText>

            {error ? (
              <AppText variant="caption" color={colors.danger} align="center">
                {error}
              </AppText>
            ) : null}

            <Button label="Create account" size="lg" fullWidth loading={loading} onPress={submit} />

            <AnimatedPressable
              onPress={() => router.replace('/')}
              haptic="tapLight"
              hitSlop={8}
              accessibilityRole="button">
              <AppText variant="caption" color={colors.accentLink} align="center">
                Already have an account? Sign in
              </AppText>
            </AnimatedPressable>
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
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.sm,
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  body: {
    marginBottom: spacing.sm,
  },
  form: {
    gap: spacing.md,
  },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    fontSize: 16,
    color: colors.textPrimary,
  },
  rules: {
    lineHeight: 18,
  },
});
