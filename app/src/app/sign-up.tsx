import { useRouter } from 'expo-router';
import { useState } from 'react';
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
import { signUpCustomer } from '@/lib/account';

/**
 * Customer self-signup.
 *
 * Every account created here is a CUSTOMER. Staff access is only ever granted
 * by Devon or Isaiah adding a row to `employees` — which no client key can do,
 * because that table has RLS on and no write policies at all.
 *
 * The password rules shown are the ones Supabase actually enforces; the server
 * is the authority, this text is just so people aren't guessing.
 */
export default function SignUpScreen() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

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
    if (result.needsConfirmation) setSent(true);
    else router.replace('/customer');
  };

  if (sent) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.centered}>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.body}>
            We sent a confirmation link to {email.trim()}. Open it to finish creating your
            account, then come back and sign in.
          </Text>
          <Pressable
            onPress={() => router.replace('/')}
            style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
            <Text style={styles.buttonText}>Back to sign in</Text>
          </Pressable>
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
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.body}>
            For DC Solar customers. Crew accounts are set up by the office — if you work here,
            ask Devon or Isaiah instead of signing up.
          </Text>

          <View style={styles.form}>
            <TextInput
              style={styles.input}
              placeholder="Full name"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="words"
              value={fullName}
              onChangeText={setFullName}
            />
            <TextInput
              style={styles.input}
              placeholder="Email"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoComplete="email"
              keyboardType="email-address"
              value={email}
              onChangeText={setEmail}
            />
            <TextInput
              style={styles.input}
              placeholder="Password"
              placeholderTextColor={colors.inkSoft}
              secureTextEntry
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={submit}
            />
            <Text style={styles.rules}>
              At least 10 characters, with an uppercase letter, a lowercase letter and a number.
              Passwords found in known data breaches are rejected.
            </Text>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              onPress={submit}
              disabled={loading}
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              {loading ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Text style={styles.buttonText}>Create account</Text>
              )}
            </Pressable>

            <Pressable onPress={() => router.replace('/')} hitSlop={8}>
              <Text style={styles.link}>Already have an account? Sign in</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.cream },
  flex: { flex: 1 },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
    gap: spacing.md,
    maxWidth: 460,
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
  title: { color: colors.ink, fontSize: 26, fontWeight: '800' },
  body: { color: colors.inkSoft, fontSize: 14, lineHeight: 21, marginBottom: spacing.sm },
  form: { gap: spacing.md },
  input: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    fontSize: 16,
    color: colors.ink,
  },
  rules: { color: colors.inkSoft, fontSize: 12, lineHeight: 18 },
  button: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
    ...shadows.card,
  },
  buttonText: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  pressed: { opacity: 0.8 },
  link: { color: colors.ocean, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  error: { color: colors.danger, fontSize: 13, fontWeight: '600', textAlign: 'center' },
});
