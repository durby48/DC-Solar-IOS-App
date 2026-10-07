import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { LeadMapBody } from '@/components/map/LeadMapBody';
import { AppText } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';

/**
 * The sales Lead map TAB (2026-10-09) — took the Keypad's place in the bar;
 * the keypad is the round button bottom-right on every screen (KeypadFab).
 */
export default function LeadMapTab() {
  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.titleRow}>
        <AppText variant="title" color={colors.textPrimary}>
          Lead map
        </AppText>
      </View>
      <LeadMapBody />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  titleRow: { paddingHorizontal: spacing.md, paddingTop: spacing.sm },
});
