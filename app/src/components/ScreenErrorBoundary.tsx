import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import * as Updates from 'expo-updates';
import { useEffect } from 'react';
import { DevSettings, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '@/constants/theme';
import { reportDiagnostic } from '@/lib/diagnostics';

/**
 * Error screens (2026-11-08).
 *
 * expo-router wraps a route in its file's exported `ErrorBoundary`. Until
 * now only the ROOT layout exported one, so a render error in any screen
 * replaced the whole app — navigator, header and back arrow gone — and its
 * "Go to Home" dispatched to a navigator that no longer existed: the blank
 * "Cannot read property 'id' of null" screen with no way out.
 *
 *  - `ScreenErrorBoundary`: re-exported as `ErrorBoundary` by record screens
 *    and tabs. Only that screen is replaced; the Stack header / tab bar stay,
 *    and "Go back" / "Go to Home" work because the navigator is still there.
 *  - `RootErrorBoundary`: the last resort in app/_layout.tsx. Nothing is left
 *    to navigate with, so "Go to Home" restarts the JS (lands on Home).
 */

function useReport(error: Error, where: string) {
  useEffect(() => {
    reportDiagnostic('js_error', false, {
      where,
      message: error.message,
      stack: (error.stack ?? '').split('\n').slice(0, 6).join(' | '),
    });
  }, [error, where]);
}

function restartApp(): void {
  if (Platform.OS === 'web') {
    try {
      window.location.assign('/');
    } catch {
      // nothing else to try
    }
    return;
  }
  void Updates.reloadAsync().catch(() => {
    try {
      DevSettings.reload();
    } catch {
      // nothing else to try
    }
  });
}

export function ScreenErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  useReport(error, 'screen');
  const goBack = () => {
    try {
      if (router.canGoBack()) router.back();
      else router.navigate('/' as never);
    } catch {
      restartApp();
    }
  };
  const goHome = () => {
    try {
      if (router.canDismiss()) router.dismissAll();
      router.navigate('/' as never);
    } catch {
      restartApp();
    }
  };
  return (
    <View style={styles.screen}>
      <Ionicons name="warning-outline" size={28} color={colors.ocean} />
      <Text style={styles.title}>This screen hit a problem</Text>
      <Text style={styles.body}>{error.message}</Text>
      <Pressable onPress={() => void retry()} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
      <View style={styles.links}>
        <Pressable onPress={goBack} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
          <Text style={styles.linkText}>Go back</Text>
        </Pressable>
        <Pressable onPress={goHome} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
          <Text style={styles.linkText}>Go to Home</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function RootErrorBoundary({ error, retry }: { error: Error; retry: () => Promise<void> }) {
  useReport(error, 'root');
  return (
    <View style={styles.screen}>
      <Ionicons name="warning-outline" size={28} color={colors.ocean} />
      <Text style={styles.title}>Something went wrong</Text>
      <Text style={styles.body}>{error.message}</Text>
      <Pressable onPress={restartApp} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
        <Text style={styles.buttonText}>Go to Home</Text>
      </Pressable>
      <Pressable onPress={() => void retry()} style={({ pressed }) => [styles.link, pressed && styles.pressed]}>
        <Text style={styles.linkText}>Try again</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
    paddingTop: 64,
    backgroundColor: colors.surfaceAlt,
  },
  title: { color: colors.ink, fontSize: 18, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center' },
  button: { marginTop: 8, backgroundColor: colors.sun, borderRadius: 999, paddingHorizontal: 22, paddingVertical: 10 },
  buttonText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800' },
  links: { flexDirection: 'row', gap: 16 },
  link: { padding: 8 },
  linkText: { color: colors.ocean, fontSize: 13, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
