import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppText, Card, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchStorms, hailLabel, stormDayLabel, type Storm } from '@/lib/storms';

/**
 * `/storm-reports` — Storm reports (2026-10-09). Sales Settings (reps and the
 * sales manager) and the CRM hub (admins). Every hail storm (≥ 1 inch) of the
 * last 2 years that hit someone the caller can see, newest first; a rep sees
 * only storms that hit their own leads / customers, with their own counts.
 */
export default function StormReportsScreen() {
  const router = useRouter();
  const [storms, setStorms] = useState<Storm[] | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchStorms().then(setStorms);
    }, []),
  );

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: 'Storm reports' }} />
      <AppText variant="caption" color={colors.textSecondary}>
        Hail of 1 inch or more within 3 miles of a lead or customer, from NOAA storm reports. Tap a storm for who was
        in its path.
      </AppText>

      {!storms ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : storms.length === 0 ? (
        <AppText variant="body" color={colors.textSecondary}>
          No hail has hit your leads or customers in the last 2 years.
        </AppText>
      ) : (
        <Card padded={false}>
          {storms.map((s, i) => (
            <Pressable
              key={s.day}
              onPress={() => router.push({ pathname: '/storm-reports/[day]', params: { day: s.day } } as never)}
              style={({ pressed }) => [styles.row, i > 0 && styles.rowBorder, pressed && styles.pressed]}>
              <View style={styles.icon}>
                <Ionicons name="thunderstorm" size={18} color={colors.ocean} />
              </View>
              <View style={styles.body}>
                <Text style={styles.title} numberOfLines={1}>
                  {stormDayLabel(s.day)} · up to {hailLabel(s.maxHail)}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {s.places.slice(0, 3).join(', ') || 'Kansas City area'}
                </Text>
                <Text style={styles.counts}>
                  {s.customers} customer{s.customers === 1 ? '' : 's'} · {s.leads} lead{s.leads === 1 ? '' : 's'} affected
                </Text>
              </View>
              {s.checkedAt ? (
                <View style={styles.checked}>
                  <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                  <Text style={styles.checkedText}>Checked</Text>
                </View>
              ) : null}
              <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
            </Pressable>
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 680, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface },
  rowBorder: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  icon: { width: 34, height: 34, borderRadius: radii.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.skySoft },
  body: { flex: 1, minWidth: 0, gap: 1 },
  title: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  sub: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  counts: { color: colors.ink, fontSize: 12, fontWeight: '700', marginTop: 2 },
  checked: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  checkedText: { color: colors.success, fontSize: 11, fontWeight: '800' },
});
