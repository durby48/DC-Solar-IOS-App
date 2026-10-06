import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, View } from 'react-native';

import { AppText, Card, ListRow, Screen, SectionHeader } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { fetchResources, resourceFileUrl, type SalesResource } from '@/lib/salesResources';
import { fetchServicePlans, formatCents, type ServicePlan } from '@/lib/servicePlans';

/**
 * `/resources` — Sales resources (2026-10-07). Rep Settings → Sales
 * resources, the admins' Menu → CRM, and the call screen's Script button.
 *
 *   Brochure      the uploaded PDF(s), opened in the browser / phone viewer
 *   Call script   the main script → /resources/[id]
 *   Situations    "if it's this kind of call…"
 *   Objections    "if they say X, say Y"
 *   Plans & prices  the live plan amounts → /plans
 *
 * Content is managed by admins in CRM Settings → Sales resources.
 */
export default function ResourcesScreen() {
  const router = useRouter();
  const [items, setItems] = useState<SalesResource[] | null>(null);
  const [plans, setPlans] = useState<ServicePlan[]>([]);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchResources().then(setItems);
      void fetchServicePlans().then(setPlans);
    }, []),
  );

  const openFile = async (r: SalesResource) => {
    if (!r.filePath) return;
    setError(null);
    const url = await resourceFileUrl(r.filePath);
    if (url) void Linking.openURL(url);
    else setError('Could not open that file. Try again.');
  };
  const open = (r: SalesResource) => router.push({ pathname: '/resources/[id]', params: { id: r.id } } as never);

  if (!items) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Sales resources' }} />
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }
  const files = items.filter((r) => r.kind === 'file');
  const scripts = items.filter((r) => r.kind === 'script');
  const situations = items.filter((r) => r.kind === 'situation');
  const objections = items.filter((r) => r.kind === 'objection');

  const list = (rows: SalesResource[], icon: 'call' | 'compass' | 'chatbubbles', empty: string) => (
    <Card padded={false}>
      {rows.length === 0 ? (
        <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
          {empty}
        </AppText>
      ) : (
        rows.map((r, i) => (
          <ListRow
            key={r.id}
            icon={icon}
            iconColor={hubColors.crm.fg}
            iconBackground={hubColors.crm.bg}
            title={r.title}
            onPress={() => open(r)}
            divider={i < rows.length - 1}
          />
        ))
      )}
    </Card>
  );

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Sales resources' }} />

      <View>
        <SectionHeader title="Brochure" accent={hubColors.crm.fg} />
        <Card padded={false}>
          {files.length === 0 ? (
            <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
              The brochure is on its way.
            </AppText>
          ) : (
            files.map((r, i) => (
              <ListRow
                key={r.id}
                icon="document-text"
                iconColor={hubColors.crm.fg}
                iconBackground={hubColors.crm.bg}
                title={r.title}
                subtitle="Open the PDF"
                onPress={() => void openFile(r)}
                divider={i < files.length - 1}
              />
            ))
          )}
        </Card>
      </View>

      <View>
        <SectionHeader title="Call script" accent={hubColors.crm.fg} />
        {list(scripts, 'call', 'No script yet.')}
      </View>

      <View>
        <SectionHeader title="Situations" subtitle="If it's this kind of call" accent={hubColors.crm.fg} />
        {list(situations, 'compass', 'No situations yet.')}
      </View>

      <View>
        <SectionHeader title="Objections" subtitle="If they say…" accent={hubColors.crm.fg} />
        {list(objections, 'chatbubbles', 'No objections yet.')}
      </View>

      <View>
        <SectionHeader title="Plans & prices" accent={hubColors.crm.fg} />
        <Card padded={false}>
          <ListRow
            icon="pricetags"
            iconColor={hubColors.crm.fg}
            iconBackground={hubColors.crm.bg}
            title={plans.length ? plans.map((p) => `${p.label} ${formatCents(p.amountCents)}`).join(' · ') : 'Plans & prices'}
            subtitle="What's included, and how billing works"
            onPress={() => router.push('/plans' as never)}
          />
        </Card>
      </View>

      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  empty: { padding: spacing.md },
});
