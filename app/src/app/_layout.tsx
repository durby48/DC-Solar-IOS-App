import { DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { colors } from '@/constants/theme';
import { configureNotificationHandler } from '@/lib/notifications';

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
        }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="set-password" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="job/[id]" options={{ title: 'Job' }} />
        <Stack.Screen name="document-builder" options={{ title: 'New document' }} />
        <Stack.Screen name="job-editor" options={{ title: 'Project' }} />
      </Stack>
    </ThemeProvider>
  );
}
