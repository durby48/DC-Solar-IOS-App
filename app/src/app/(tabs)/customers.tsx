import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useNavigation } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { CustomerList } from '@/components/crm/CustomerList';
import { AppText, Screen } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';

/**
 * The Customers tab.
 *
 * A shell around `components/crm/CustomerList`, which is the same screen
 * `/crm` used to serve — the CRM was written with this tab in mind, which is
 * why the list lives in `components/` rather than in a route file. `/crm` is
 * now a redirect here, so there is exactly one customer list at exactly one
 * URL.
 *
 * `scroll={false}`: the list is a `FlatList` and does its own scrolling.
 *
 * THE TITLE IS CENTRED (2026-08-22), with the live count centred beneath it.
 * The count has to come UP from the list — only the list knows what survived
 * the Show filter — so `CustomerList` reports it through `onSummaryChange`.
 * `setSummary` is a `useState` setter, whose identity never changes, which is
 * what keeps that callback out of a render loop.
 *
 * THE BACK ARROW (2026-09-12). Customers is a hidden tab (`href: null`), so
 * it never gets a stack header, and the Menu / CRM hub rows that open it left
 * people with only the tab bar as a way out. The arrow goes back through tab
 * history (the tabs navigator uses `backBehavior="history"`), and falls back
 * to the Menu when there is no history — a deep link or a web refresh.
 */
export default function CustomersTab() {
  const [summary, setSummary] = useState<string | null>(null);
  const navigation = useNavigation();

  const goBack = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else router.navigate('/more');
  };

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <View style={styles.header}>
          <Pressable
            onPress={goBack}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <Ionicons name="chevron-back" size={26} color={hubColors.crm.fg} />
          </Pressable>
          <AppText variant="title" align="center">
            Customers
          </AppText>
          {summary ? (
            <AppText variant="caption" align="center" color={colors.textMuted}>
              {summary}
            </AppText>
          ) : null}
        </View>
      }>
      <CustomerList onSummaryChange={setSummary} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    gap: spacing.xs,
  },
  // Pinned left so the title stays centred on the screen.
  back: {
    position: 'absolute',
    left: -spacing.sm,
    top: 0,
    padding: spacing.xs,
    zIndex: 1,
  },
  pressed: { opacity: 0.6 },
});
