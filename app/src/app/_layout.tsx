// Deep per-weight imports, NOT `from '@expo-google-fonts/inter'`. The package
// root re-exports all 18 Inter faces and all 8 Sora faces, and Metro follows
// every `require` in it — importing from the root put 6.5 MB of .ttf into the
// web export and into every OTA update. These six paths ship 6 files.
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_500Medium } from '@expo-google-fonts/inter/500Medium';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { Sora_700Bold } from '@expo-google-fonts/sora/700Bold';
import { Sora_800ExtraBold } from '@expo-google-fonts/sora/800ExtraBold';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useFonts } from 'expo-font';
import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ConnectionBanner } from '@/components/ConnectionBanner';
import { colors } from '@/constants/theme';
import { configureNotificationHandler } from '@/lib/notifications';

/**
 * Web-only header back button: the native-stack header on web doesn't
 * render its back arrow (it does on iOS), so supply one explicitly.
 */
function WebBackButton() {
  return (
    <Pressable
      onPress={() => (router.canGoBack() ? router.back() : router.replace('/(tabs)' as never))}
      hitSlop={8}
      style={({ pressed }) => [{ paddingRight: 12, opacity: pressed ? 0.6 : 1 }]}>
      <Ionicons name="chevron-back" size={24} color={colors.ocean} />
    </Pressable>
  );
}

// Show notification banners even while the app is in the foreground.
configureNotificationHandler();

/**
 * Hold the splash while the six font faces load.
 *
 * Called at module scope, not in an effect, because by the time an effect
 * runs the splash may already have auto-hidden and the app would flash
 * system-font text before swapping to Sora/Inter. `.catch()` because on web
 * (and on a fast remount) this legitimately rejects, and it must never take
 * the app down.
 */
void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * The app's typefaces: Sora for headings (matching dcsolarkc.com), Inter for
 * everything else. These six keys are exactly the family names in
 * `constants/theme.ts`'s `fonts` export — change one and you change both.
 *
 * There is deliberately NO global default font. RN has no cascade, so type
 * reaches screens only through `<AppText>` / the `components/ui` primitives;
 * a "default" would silently miss every plain `<Text>` still in the app and
 * we'd ship two typefaces on one screen without noticing.
 */
const FONT_FACES = {
  Sora_700Bold,
  Sora_800ExtraBold,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
};

const appTheme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.ocean,
    background: colors.cream,
    card: colors.cream,
    text: colors.ink,
    border: colors.tan,
  },
};

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts(FONT_FACES);

  /**
   * Fonts NEVER block the app.
   *
   * A crew member whose phone failed to decode a font file still has to be
   * able to clock in, so an error is treated exactly like success: hide the
   * splash and render. RN falls back to the system face for any `fontFamily`
   * it can't resolve, so the app looks plainer and works identically. The
   * error is not surfaced — there is nothing the person could do about it.
   */
  useEffect(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync().catch(() => {});
    }
  }, [fontsLoaded, fontError]);

  return (
    /* Root for react-native-gesture-handler. Everything that uses a gesture
       — the media lightbox's pinch-zoom, any swipeable row — needs this
       ancestor, and it has to be the outermost view or gestures silently do
       nothing on Android. */
    <GestureHandlerRootView style={styles.root}>
      <ThemeProvider value={appTheme}>
        <StatusBar style="dark" />
        {/* Floats above every screen — login, tabs, job detail — because losing
            signal matters wherever you happen to be standing. */}
        <SafeAreaView edges={['top']} style={styles.bannerLayer} pointerEvents="box-none">
          <ConnectionBanner />
        </SafeAreaView>
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.cream },
            // Ocean-tinted plain back arrow (no route-name label); the title
            // itself stays ink via headerTitleStyle below.
            headerTintColor: colors.ocean,
            headerBackButtonDisplayMode: 'minimal',
            headerBackTitle: '',
            headerTitleStyle: { fontWeight: '700', color: colors.ink },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.cream },
            ...(Platform.OS === 'web' ? { headerLeft: () => <WebBackButton /> } : {}),
          }}>
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen
            name="set-password"
            options={{ headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen name="sign-up" options={{ headerShown: false }} />
          <Stack.Screen name="security" options={{ title: 'Security' }} />
          <Stack.Screen name="customer" options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="job/[id]" options={{ title: 'Job' }} />
          <Stack.Screen name="document-builder" options={{ title: 'New document' }} />
          <Stack.Screen name="job-editor" options={{ title: 'Project' }} />
        </Stack>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  // Sits above the navigator without capturing touches, so the banner never
  // blocks the screen underneath it.
  bannerLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
  },
});
