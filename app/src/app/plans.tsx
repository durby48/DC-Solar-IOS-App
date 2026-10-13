import { Image } from 'expo-image';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { AppText, Card, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchArtUrls, TIER_ART, type ArtKey } from '@/lib/marketingArt';
import { commercialCovers, fetchServicePlans, formatCents, type ServicePlan } from '@/lib/servicePlans';

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
  'Panel cleaning is an optional add-on, never included: 5% off with Bronze, 10% with Silver, 15% with Gold — the same as removal & reinstall.',
  'Commercial buildings use the commercial price: Bronze covers up to 100 panels, Silver up to 250, and anything over 250 panels is Gold. Put the panel count on the lead before booking.',
  'You can sell a custom yearly price; it is billed the same way.',
  'You earn 30% of every payment from customers you sold — first year and renewals.',
];

export default function PlansScreen() {
  const [plans, setPlans] = useState<ServicePlan[] | null>(null);
  const [art, setArt] = useState<Partial<Record<ArtKey, string>>>({});

  useFocusEffect(
    useCallback(() => {
      void fetchServicePlans().then(setPlans);
      void fetchArtUrls(['shield-program', ...Object.values(TIER_ART)], 640).then(setArt);
    }, []),
  );

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      {/* Sold as the Solar Shield program (2026-10-12); art from marketing-art. */}
      <AppText variant="heading" color={colors.textPrimary}>
        Solar Shield · powered by DC Solar
      </AppText>
      {art['shield-program'] ? (
        <Image source={{ uri: art['shield-program'] }} style={styles.banner} contentFit="cover" transition={150} />
      ) : null}
      {plans === null ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : (
        plans.map((p) => {
          const tint = TIER_TINT[p.tier] ?? { fg: hubColors.crm.fg, bg: hubColors.crm.bg };
          return (
            <Card key={p.tier} style={[styles.plan, { borderColor: tint.fg }]}>
              <View style={styles.head}>
                {art[TIER_ART[p.tier]] ? (
                  <Image source={{ uri: art[TIER_ART[p.tier]] }} style={styles.thumb} contentFit="cover" transition={150} />
                ) : null}
                <View style={[styles.badge, { backgroundColor: tint.bg }]}>
                  <AppText variant="bodyStrong" color={tint.fg}>
                    {p.label}
                  </AppText>
                </View>
                <AppText variant="title" color={colors.textPrimary} style={styles.price}>
                  {formatCents(p.amountCents)}
                  <AppText variant="body" color={colors.textSecondary}>
                    {' '}
                    / year
                  </AppText>
                </AppText>
              </View>
              {p.commercial ? (
                <AppText variant="bodyStrong" color={colors.textPrimary}>
                  Commercial: {formatCents(p.commercial.amountCents)} / year · {commercialCovers(p)}
                </AppText>
              ) : null}
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
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  banner: { width: '100%', aspectRatio: 16 / 9, borderRadius: radii.md, backgroundColor: colors.surface },
  thumb: { width: 56, height: 70, borderRadius: radii.sm },
  price: { marginLeft: 'auto' },
  badge: { paddingHorizontal: spacing.md, paddingVertical: 4, borderRadius: radii.pill },
  terms: { gap: spacing.xs },
});
