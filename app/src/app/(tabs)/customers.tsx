import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { CustomerList } from '@/components/crm/CustomerList';
import { AppText, Screen } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';

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
 */
export default function CustomersTab() {
  const [summary, setSummary] = useState<string | null>(null);

  return (
    <Screen
      scroll={false}
      padded={false}
      header={
        <View style={styles.header}>
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
});
