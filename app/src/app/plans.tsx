import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppText, Card, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchServicePlans, formatCents, type ServicePlan } from '@/lib/servicePlans';

/**
 * `/plans` — Plans & prices (2026-10-06): the rep's quick reference while on a
 * call. Prices and "what's included" come from `service_plans` (admins edit
 * them in CRM Settings → Service plans), so this never goes stale; the terms
 * below are how billing actually works in the app.
 */
const TIER_TINT: Record<string, { fg: string; bg: string }> = {
  bronze: { fg: colors.coralDeep, bg: colors.coralSoft },
  silver: { fg: colors.slateDeep, bg: colors.slateSoft },
  gold: { fg: colors.amberDeep, bg: colors.amberSoft },
};

const TERMS = [
  'Every plan is billed yearly, with a 2-year minimum agreement.',
  'Nothing is charged when they save their card — the first year is charged after the first service visit.',
  'The second year renews automatically 12 months later.',
  'You can sell a custom yearly price; it is billed the same way.',
  'You earn 30% of every payment from customers you sold — first year and renewals.',
];

export default function PlansScreen() {
  const [plans, setPlans] = useState<ServicePlan[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchServicePlans().then(setPlans);
    }, []),
  );

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      {plans === null ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : (
        plans.map((p) => {
          const tint = TIER_TINT[p.tier] ?? { fg: hubColors.crm.fg, bg: hubColors.crm.bg };
          return (
            <Card key={p.tier} style={[styles.plan, { borderColor: tint.fg }]}>
              <View style={styles.head}>
                <View style={[styles.badge, { backgroundColor: tint.bg }]}>
                  <AppText variant="bodyStrong" color={tint.fg}>
                    {p.label}
                  </AppText>
                </View>
                <AppText variant="title" color={colors.textPrimary}>
                  {formatCents(p.amountCents)}
                  <AppText variant="body" color={colors.textSecondary}>
                    {' '}
                    / year
                  </AppText>
                </AppText>
              </View>
              {p.includes ? (
                p.includes
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => (
                    <AppText key={line} variant="body" color={colors.textPrimary}>
                      ✓ {line.replace(/^[-•✓]\s*/, '')}
                    </AppText>
                  ))
              ) : (
                <AppText variant="caption" color={colors.textSecondary}>
                  What&apos;s included is being finalized.
                </AppText>
              )}
            </Card>
          );
        })
      )}

      <Card style={styles.terms}>
        <AppText variant="heading" color={colors.textPrimary}>
          How it works
        </AppText>
        {TERMS.map((t) => (
          <AppText key={t} variant="body" color={colors.textSecondary}>
            • {t}
          </AppText>
        ))}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  plan: { gap: spacing.xs, borderWidth: 1.5, borderRadius: radii.md },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: spacing.xs },
  badge: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radii.pill },
  terms: { gap: spacing.xs },
});
