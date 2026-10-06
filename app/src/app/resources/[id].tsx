import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';

import { ResourceText } from '@/components/resources/ResourceText';
import { AppText, Card, Screen } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { fetchResource, type SalesResource } from '@/lib/salesResources';

/** `/resources/[id]` — one script, situation or objection, in big readable text (2026-10-07). */
export default function ResourceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [item, setItem] = useState<SalesResource | null | 'loading'>('loading');

  useFocusEffect(
    useCallback(() => {
      if (id) void fetchResource(String(id)).then(setItem);
    }, [id]),
  );

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: item && item !== 'loading' ? item.title : 'Sales resources' }} />
      {item === 'loading' ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : !item ? (
        <AppText variant="body" color={colors.textSecondary}>
          This was removed.
        </AppText>
      ) : (
        <Card style={styles.card}>
          <ResourceText body={item.body} />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  card: { padding: spacing.lg },
});
