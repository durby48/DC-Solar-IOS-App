import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, View } from 'react-native';

import { AppText, Card, Screen } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { fetchMyPrefs, saveMyPrefs, type MyPrefs } from '@/lib/repSettings';

/**
 * `/notifications` (2026-10-06, rep Settings): which pushes reach this person.
 * Saved on their staff_profiles row; the `notify` edge function drops a push
 * addressed to them when its switch is off. Turning one off does not hide
 * anything in the app — texts and missed calls still show on Home and in the
 * CRM.
 */
const ROWS: { key: 'notifyTexts' | 'notifyMissedCalls' | 'notifyNewProspects'; title: string; detail: string }[] = [
  { key: 'notifyTexts', title: 'New texts', detail: 'When someone texts your DC Solar number' },
  { key: 'notifyMissedCalls', title: 'Missed calls', detail: 'When a call to your number is not answered' },
  { key: 'notifyNewProspects', title: 'New prospects', detail: 'When an admin assigns a prospect to you' },
];

export default function NotificationsScreen() {
  const [prefs, setPrefs] = useState<MyPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchMyPrefs().then(setPrefs);
    }, []),
  );

  const toggle = async (key: (typeof ROWS)[number]['key'], value: boolean) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, [key]: value });
    setError(null);
    const result = await saveMyPrefs({ [key]: value });
    if (!result.ok) {
      setPrefs(previous);
      setError(result.message);
    }
  };

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      {!prefs ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      ) : (
        <Card style={styles.card}>
          {ROWS.map((r, i) => (
            <View key={r.key} style={[styles.row, i < ROWS.length - 1 && styles.divider]}>
              <View style={styles.flex}>
                <AppText variant="bodyStrong">{r.title}</AppText>
                <AppText variant="caption" color={colors.textSecondary}>
                  {r.detail}
                </AppText>
              </View>
              <Switch value={prefs[r.key]} onValueChange={(v) => void toggle(r.key, v)} />
            </View>
          ))}
        </Card>
      )}
      <AppText variant="caption" color={colors.textSecondary}>
        Turning one off only stops the buzz. Everything still shows on Home and in the CRM.
      </AppText>
      {error ? (
        <AppText variant="caption" color={colors.danger}>
          {error}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  loading: { marginVertical: spacing.xl },
  card: { paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  flex: { flex: 1, gap: 2 },
});
