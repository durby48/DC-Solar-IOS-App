import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Image as ExpoImage } from 'expo-image';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { landingRoute } from '@/lib/account';
import { pendingChallenge, submitChallenge } from '@/lib/mfa';
import { supabase } from '@/lib/supabase';
import { verseOfTheDay } from '@/lib/verses';

/** Aspect ratio of the backdrop artwork (720 x 1150). */
const ART_ASPECT = 720 / 1150;

export default function LoginScreen() {
  const router = useRouter();
  const { width, height } = useWindowDimensions();
  // A phone is narrower than the artwork, so `cover` crops a sliver off the
  // sides and looks right. A desktop browser is far WIDER than a portrait
  // clip — `cover` there blows it up until only a magnified vertical strip is
  // visible. Once the window is wider than the art, switch to `contain` so the
  // whole composition shows, with the navy page colour filling the sides.
  const fit = width / height > ART_ASPECT ? 'contain' : 'cover';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Second step for staff with 2FA on: the session is signed in but only at
  // aal1 until a code is entered.
  const [challengeFactor, setChallengeFactor] = useState<string | null>(null);
  const [code, setCode] = useState('');

  /** Send staff to the app and everyone else to the customer portal. */
  const routeByAccount = async () => {
    router.replace(await landingRoute());
  };

  const verifyCode = async () => {
    if (!challengeFactor) return;
    setLoading(true);
    setError(null);
    const result = await submitChallenge(challengeFactor, code);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    await routeByAccount();
  };

  const signIn = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: authError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (authError) {
        setError(authError.message);
        return;
      }
      if (data.user?.user_metadata?.must_change_password) {
        router.replace('/set-password');
        return;
      }
      // 2FA: if this account has a verified factor, finish before routing.
      const challenge = await pendingChallenge();
      if (challenge.required && challenge.factorId) {
        setChallengeFactor(challenge.factorId);
        return;
      }
      await routeByAccount();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      {/* Devon's own Gemini clip, converted to a looping animated WebP (real
          video would need a native player and therefore a full App Store
          build). The JPEG underneath is the first frame — it paints instantly
          and is what shows if the animation ever fails to decode. */}
      <ExpoImage
        source={require('@/assets/images/login-solarflow.webp')}
        // First frame as the placeholder: paints instantly while the animation
        // decodes, and is what shows if it ever fails. It was previously a
        // separate RN <Image>, which RN-Web laid out at the file's natural
        // 768x1376 anchored top-left rather than filling the screen — invisible
        // while the animation used `cover`, obvious the moment it didn't.
        placeholder={require('@/assets/images/login-solarflow.jpg')}
        placeholderContentFit={fit}
        style={StyleSheet.absoluteFill}
        contentFit={fit}
        cachePolicy="memory-disk"
        transition={220}
      />
      <View style={styles.vignette} pointerEvents="none" />
      <SafeAreaView style={styles.safe}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          contentContainerStyle={styles.container}
          keyboardShouldPersistTaps="handled">
          <Image
            source={require('@/assets/images/logo.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <View style={styles.verseBlock}>
            <Text style={styles.verseText}>“{verseOfTheDay().text}”</Text>
            <Text style={styles.verseReference}>— {verseOfTheDay().reference}</Text>
          </View>

          {challengeFactor ? (
            <View style={styles.form}>
              <Text style={styles.verseReference}>Enter the 6-digit code from your authenticator</Text>
              <TextInput
                style={[styles.input, styles.codeInput]}
                value={code}
                onChangeText={setCode}
                placeholder="000000"
                placeholderTextColor={colors.inkSoft}
                keyboardType="number-pad"
                maxLength={6}
                autoFocus
                onSubmitEditing={verifyCode}
              />
              {error ? <Text style={styles.error}>{error}</Text> : null}
              <Pressable
                style={({ pressed }) => [styles.button, pressed && styles.pressed]}
                onPress={verifyCode}
                disabled={loading || code.length < 6}>
                {loading ? (
                  <ActivityIndicator color={colors.ink} />
                ) : (
                  <Text style={styles.buttonText}>Verify</Text>
                )}
              </Pressable>
            </View>
          ) : (
          <View style={styles.form}>
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
              onSubmitEditing={signIn}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.pressed]}
              onPress={signIn}
              disabled={loading}>
              {loading ? (
                <ActivityIndicator color={colors.ink} />
              ) : (
                <Text style={styles.buttonText}>Sign in</Text>
              )}
            </Pressable>

            <Pressable onPress={() => router.push('/sign-up' as never)} hitSlop={8}>
              <Text style={styles.signUpLink}>New customer? Create an account</Text>
            </Pressable>
          </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0B1220',
  },
  safe: {
    flex: 1,
  },
  // Darkens the outer edges so the form keeps contrast wherever the mesh is
  // bright, without dulling the centre bloom.
  vignette: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(6,12,24,0.28)',
  },
  flex: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xl,
    gap: spacing.md,
  },
  logo: {
    width: 240,
    height: 91,
  },
  verseBlock: {
    maxWidth: 340,
    alignItems: 'center',
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  verseText: {
    color: '#241C13',
    textShadowColor: 'rgba(255,248,234,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 7,
    fontSize: 15,
    fontWeight: '600',
    fontStyle: 'italic',
    textAlign: 'center',
    lineHeight: 22,
  },
  verseReference: {
    color: '#134C70',
    textShadowColor: 'rgba(255,248,234,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 7,
    fontSize: 13,
    fontWeight: '800',
  },
  form: {
    width: '100%',
    maxWidth: 400,
    gap: spacing.md,
  },
  input: {
    // Frosted panel over the artwork — opaque enough to type against, light
    // enough that the mesh still shows through at the edges.
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md - 2,
    fontSize: 16,
    color: colors.ink,
  },
  codeInput: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 8,
    textAlign: 'center',
  },
  signUpLink: {
    color: '#12405E',
    fontSize: 14,
    fontWeight: '800',
    textAlign: 'center',
    textShadowColor: 'rgba(255,248,234,0.95)',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 7,
  },
  error: {
    color: '#FFB4A8',
    fontSize: 14,
    textAlign: 'center',
  },
  button: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md,
    alignItems: 'center',
    ...shadows.card,
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
