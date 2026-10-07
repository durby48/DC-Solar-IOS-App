import { Redirect, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { SalesDialer } from '@/components/phone/SalesDialer';
import { AppText } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { takePresetDial } from '@/lib/dialHandoff';
import { useRoleGate } from '@/lib/role';

/**
 * `/keypad` — the sales dial pad as a screen (2026-10-06). Since 2026-10-09
 * reps normally dial from the keypad WINDOW (the bottom-right button,
 * components/phone/DialerWindow); this route stays for links and bookmarks.
 * The pad itself is components/phone/SalesDialer.
 *
 * Admins and crew keep the Phone app's keypad (`/phone/keypad`); this tab is
 * hidden from them and sends them there if they land on it.
 */
export default function KeypadTab() {
  const gate = useRoleGate();
  const [reloadKey, setReloadKey] = useState(0);
  const [preset, setPreset] = useState<{ phone: string; n: number } | null>(null);

  useFocusEffect(
    useCallback(() => {
      setReloadKey((k) => k + 1);
      const phone = takePresetDial();
      if (phone) setPreset((p) => ({ phone, n: (p?.n ?? 0) + 1 }));
    }, []),
  );

  if (gate.phase === 'ready' && !gate.role?.isSales) return <Redirect href="/phone/keypad" />;
  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.head}>
        <AppText variant="heading" color={colors.textPrimary}>
          Keypad
        </AppText>
      </View>
      <SalesDialer preset={preset} reloadKey={reloadKey} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  head: { width: '100%', maxWidth: 480, alignSelf: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
});
