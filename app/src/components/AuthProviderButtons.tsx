import * as AppleAuthentication from 'expo-apple-authentication';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  appleAvailable,
  signInWithApple,
  signInWithGoogle,
  socialLoginConfigured,
  type OAuthResult,
} from '@/lib/oauth';

/**
 * "Continue with Apple / Google" for the CUSTOMER sign-up screen (2026-08-22).
 *
 * Mounted on `sign-up.tsx` only. The staff login screen (`app/index.tsx`) has
 * no social buttons by design — staff sign in with a password and a 6-digit
 * code, and the server refuses google/apple identities on a staff email
 * outright (`2026-08-22_oauth_staff_block.sql`).
 *
 * ORDER AND SIZE ARE A REQUIREMENT, NOT A PREFERENCE. App Store guideline 4.8
 * and Apple's HIG say Sign in with Apple must be at least as prominent as any
 * other third-party option, so on iOS it comes first and both pills share one
 * height. The Apple pill is Apple's own native `AppleAuthenticationButton` —
 * automatically localised, accessible, and by definition compliant.
 *
 * Renders NOTHING until `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` is set. Until Devon
 * creates the OAuth clients there is nothing behind these buttons, and a
 * control that always fails is worse than no control. See
 * `docs/SOCIAL_LOGIN_SETUP.md`.
 */

/** Both pills, and Apple's `cornerRadius`, key off this. */
const BUTTON_HEIGHT = 52;

export interface AuthProviderButtonsProps {
  /**
   * Called with every outcome, including `{ok:'cancelled'}` — the caller is
   * expected to do nothing at all with that one.
   */
  onResult: (result: OAuthResult) => void;
  /** Grey both pills out while the caller is busy with its own form. */
  disabled?: boolean;
}

export default function AuthProviderButtons({ onResult, disabled = false }: AuthProviderButtonsProps) {
  const [busy, setBusy] = useState<'google' | 'apple' | null>(null);
  const [nativeApple, setNativeApple] = useState(false);

  useEffect(() => {
    let alive = true;
    appleAvailable().then((available) => {
      if (alive) setNativeApple(available);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!socialLoginConfigured()) return null;

  const isWeb = Platform.OS === 'web';
  // Apple's flow exists natively on iOS and as a plain redirect on the web.
  // Android gets Google only — there is no Apple button to show there.
  const showApple = nativeApple || isWeb;
  const locked = disabled || busy !== null;

  const run = async (provider: 'google' | 'apple') => {
    if (locked) return;
    setBusy(provider);
    const result = provider === 'google' ? await signInWithGoogle() : await signInWithApple();
    // On web a successful start has already navigated the page away; setting
    // state here is harmless either way because the component is unmounting.
    setBusy(null);
    onResult(result);
  };

  return (
    <View style={styles.wrap}>
      {showApple ? (
        nativeApple ? (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
            cornerRadius={BUTTON_HEIGHT / 2}
            style={styles.appleNative}
            onPress={() => {
              void run('apple');
            }}
          />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign in with Apple"
            accessibilityState={{ disabled: locked }}
            disabled={locked}
            onPress={() => {
              void run('apple');
            }}
            style={({ pressed }) => [
              styles.pill,
              styles.applePill,
              pressed && styles.pressed,
              locked && styles.lockedPill,
            ]}>
            {busy === 'apple' ? (
              <ActivityIndicator color={colors.white} />
            ) : (
              <>
                <AppleMark />
                <Text style={[styles.pillText, styles.applePillText]}>Sign in with Apple</Text>
              </>
            )}
          </Pressable>
        )
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Continue with Google"
        accessibilityState={{ disabled: locked }}
        disabled={locked}
        onPress={() => {
          void run('google');
        }}
        style={({ pressed }) => [
          styles.pill,
          styles.googlePill,
          pressed && styles.pressed,
          locked && styles.lockedPill,
        ]}>
        {busy === 'google' ? (
          <ActivityIndicator color={colors.ink} />
        ) : (
          <>
            <GoogleMark />
            <Text style={styles.pillText}>Continue with Google</Text>
          </>
        )}
      </Pressable>

      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.rule} />
      </View>
    </View>
  );
}

/** Google's four-colour "G", drawn rather than shipped as an asset. */
function GoogleMark() {
  return (
    <Svg width={20} height={20} viewBox="0 0 48 48">
      <Path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <Path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <Path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <Path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </Svg>
  );
}

/**
 * The Apple mark for the WEB pill only. On iOS this component is never
 * rendered — the native button draws Apple's own asset, which is the only
 * thing the HIG really wants.
 */
function AppleMark() {
  return (
    <Svg width={18} height={20} viewBox="0 0 24 24">
      <Path
        fill={colors.white}
        d="M16.365 1.43c0 1.14-.42 2.2-1.26 3.06-.99 1.02-2.14 1.62-3.4 1.53a3.7 3.7 0 0 1-.05-.47c0-1.09.47-2.24 1.3-3.09.42-.43.95-.79 1.58-1.07.63-.28 1.23-.44 1.79-.47.01.17.04.34.04.51z"
      />
      <Path
        fill={colors.white}
        d="M20.63 17.19c-.31.72-.68 1.38-1.11 1.99-.59.83-1.07 1.4-1.44 1.72-.58.52-1.2.79-1.86.81-.48 0-1.05-.14-1.72-.41-.67-.27-1.29-.41-1.85-.41-.59 0-1.22.14-1.9.41-.68.28-1.23.42-1.65.44-.64.03-1.28-.25-1.91-.83-.4-.35-.9-.94-1.5-1.79-.64-.9-1.17-1.94-1.58-3.13-.44-1.28-.66-2.52-.66-3.72 0-1.38.3-2.56.89-3.55a5.2 5.2 0 0 1 1.87-1.89c.78-.46 1.62-.7 2.53-.71.51 0 1.17.16 2 .47.82.31 1.35.47 1.58.47.18 0 .77-.19 1.77-.55.94-.34 1.74-.48 2.39-.42 1.76.14 3.09.84 3.97 2.1-1.58.96-2.36 2.3-2.34 4.02.01 1.34.5 2.46 1.46 3.34.44.42.93.74 1.47.97-.12.34-.24.66-.38.97z"
      />
    </Svg>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginBottom: spacing.sm },
  pill: {
    height: BUTTON_HEIGHT,
    borderRadius: radii.pill,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    ...shadows.card,
  },
  googlePill: {
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.line,
  },
  applePill: { backgroundColor: '#000000' },
  // The native Apple button draws its own background; it only needs a box.
  appleNative: { height: BUTTON_HEIGHT, width: '100%' },
  pillText: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  applePillText: { color: colors.white },
  pressed: { opacity: 0.8 },
  lockedPill: { opacity: 0.55 },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  rule: { flex: 1, height: 1, backgroundColor: colors.line },
  dividerText: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
});
