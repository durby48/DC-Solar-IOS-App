import Ionicons from '@expo/vector-icons/Ionicons';
import { DefaultTheme, Stack, ThemeProvider, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform, Pressable, StyleSheet } from 'react-native';
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
  return (
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
        <Stack.Screen name="set-password" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="sign-up" options={{ headerShown: false }} />
        <Stack.Screen name="customer" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="job/[id]" options={{ title: 'Job' }} />
        <Stack.Screen name="document-builder" options={{ title: 'New document' }} />
        <Stack.Screen name="job-editor" options={{ title: 'Project' }} />
      </Stack>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
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
