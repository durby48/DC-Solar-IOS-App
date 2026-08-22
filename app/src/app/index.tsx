import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import type { Session } from '@supabase/supabase-js';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import { landingRoute } from '@/lib/account';
import { clearBounceToLogin } from '@/lib/authGate';
import { pendingChallenge, submitChallenge } from '@/lib/mfa';
import { refuseStaff } from '@/lib/oauth';
import { supabase } from '@/lib/supabase';
import { verseOfTheDay } from '@/lib/verses';

/** Aspect ratio of the backdrop artwork (720 x 1150). */
const ART_ASPECT = 720 / 1150;

/**
 * Providers whose sessions must never belong to staff.
 *
 * `app_metadata.provider` is set by GoTrue, not by the client, and records how
 * the session was CREATED — `'email'` for a password sign-in, `'google'` /
 * `'apple'` for a social one. Only the social two get re-checked here; running
 * `refuseStaff()` on an email session would sign every employee out of their
 * own app.
 */
const SOCIAL_PROVIDERS = new Set(['google', 'apple']);

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

  /**
   * `true` for as long as the PASSWORD flow below is driving.
   *
   * `signInWithPassword()` fires `SIGNED_IN` the instant the password is
   * accepted — which is *before* `pendingChallenge()` has had the chance to
   * demand the 6-digit code. If the subscription acted on that event it would
   * walk an aal1 session straight into the app and the second factor would
   * become decorative. So the password flow owns its own routing, start to
   * finish, and the subscription sits it out.
   */
  const manualFlow = useRef(false);
  /**
   * One routing decision at a time. `getSession()` on mount and a `SIGNED_IN`
   * event can both land for the same session, and both would `replace()`.
   */
  const routing = useRef(false);
  const mounted = useRef(true);

  /** Send staff to the app and everyone else to the customer portal. */
  const routeByAccount = async () => {
    router.replace(await landingRoute());
  };

  /**
   * Route a session this screen did NOT create.
   *
   * Two things produce one: a completed web OAuth round-trip (Google/Apple
   * redirect back to `/`, `detectSessionInUrl` turns the URL fragment into a
   * session — see `lib/oauth.ts::startWebOAuth`), and simply opening `/` while
   * already signed in. Before this existed the first case dumped a customer
   * with a perfectly good new session back onto the staff login form.
   *
   * WHY THIS CANNOT PING-PONG WITH THE TABS GATE
   *
   * The two guards test opposite facts and are therefore mutually exclusive at
   * any instant: `(tabs)/_layout.tsx` bounces here only when `getSession()`
   * returns NO session; this routes away only when it returns ONE. A signed-out
   * visitor bounced to `/` finds nothing here and gets the form. A signed-in
   * employee routed to `/(tabs)` satisfies the gate. A customer goes to
   * `/customer`, which the gate never runs on at all.
   */
  const routeSession = useCallback(
    async (session: Session) => {
      if (manualFlow.current || routing.current) return;
      routing.current = true;
      try {
        // Web OAuth only. The BEFORE INSERT triggers in
        // `2026-08-22_oauth_staff_block.sql` are the real gate; this is the
        // same belt-and-braces `lib/oauth.ts` runs after a NATIVE social login,
        // applied to the session the web redirect dropped on us instead. It is
        // deliberately not run for `provider: 'email'` — that would sign every
        // employee out of their own login screen.
        const provider = session.user?.app_metadata?.provider;
        if (typeof provider === 'string' && SOCIAL_PROVIDERS.has(provider)) {
          const refused = await refuseStaff();
          if (refused && refused.ok === false) {
            if (mounted.current) setError(refused.message);
            return;
          }
        }

        // Never route past an unfinished second factor. This is the same check
        // the password flow makes, so a staff member who reloads the page
        // mid-challenge lands back on the code entry rather than on an aal1
        // session that quietly fails every money query.
        const challenge = await pendingChallenge();
        if (!mounted.current) return;
        if (challenge.required && challenge.factorId) {
          setChallengeFactor(challenge.factorId);
          return;
        }

        if (session.user?.user_metadata?.must_change_password) {
          router.replace('/set-password');
          return;
        }

        const target = await landingRoute();
        if (!mounted.current) return;
        router.replace(target);
      } catch {
        // Could not classify the session (offline, RLS hiccup). Leaving the
        // form up is the safe failure: they can sign in again, and nothing
        // here decides access anyway — RLS does.
      } finally {
        routing.current = false;
      }
    },
    [router],
  );

  useEffect(() => {
    mounted.current = true;
    // The tabs gate's bounce has ARRIVED — that is the only thing that proves
    // it, and the next signed-out tab visit needs its own. See `lib/authGate`.
    clearBounceToLogin();

    // (1) Already signed in when this screen loaded.
    void supabase.auth
      .getSession()
      .then(({ data }) => {
        if (mounted.current && data.session) void routeSession(data.session);
      })
      .catch(() => {
        // No session to route. The form is already on screen.
      });

    // (2) The session arrives a moment later. `detectSessionInUrl` parses the
    // `#access_token=…` fragment asynchronously, so an OAuth round-trip is
    // typically NOT visible to the `getSession()` above — this is the call
    // that actually catches it.
    //
    // The work is pushed out to a timeout ON PURPOSE. supabase-js runs this
    // callback while it still holds its auth lock, and everything
    // `routeSession()` reaches for — `getAccountInfo()`, `pendingChallenge()`,
    // `refuseStaff()`'s `signOut()` — wants that same lock. Calling them from
    // inside the callback deadlocks the client, which on web looks like a
    // login screen that simply never does anything again.
    let deferred: ReturnType<typeof setTimeout> | null = null;
    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== 'SIGNED_IN' || !session || !mounted.current) return;
      if (deferred) clearTimeout(deferred);
      deferred = setTimeout(() => {
        deferred = null;
        if (mounted.current) void routeSession(session);
      }, 0);
    });

    return () => {
      mounted.current = false;
      if (deferred) clearTimeout(deferred);
      listener.subscription.unsubscribe();
    };
  }, [routeSession]);

  const verifyCode = async () => {
    if (!challengeFactor) return;
    manualFlow.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await submitChallenge(challengeFactor, code);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await routeByAccount();
    } finally {
      setLoading(false);
      manualFlow.current = false;
    }
  };

  const signIn = async () => {
    if (!email.trim() || !password) {
      setError('Enter your email and password.');
      return;
    }
    manualFlow.current = true;
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
      // Released only here, at the very end. The `SIGNED_IN` this flow fired
      // has long since been delivered and ignored; anything arriving after
      // this point is a genuinely new session and belongs to `routeSession`.
      manualFlow.current = false;
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
