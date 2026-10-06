import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, View } from 'react-native';

import { AppText, Card, Chip, Screen } from '@/components/ui';
import { colors, hubColors, spacing } from '@/constants/theme';
import { fetchMyPrefs, hmLabel, isAwayNow, saveMyPrefs, type MyPrefs } from '@/lib/repSettings';

/**
 * `/do-not-disturb` (2026-10-06, rep Settings). Outside the hours chosen here
 * (Kansas City time), a call to the rep's DC Solar number does not ring: the
 * caller hears they are away, gets a text saying when they will be called
 * back, and it shows as a missed call — with no push, so evenings stay quiet.
 * The work is done in twilio-voice-inbound; this only saves the setting.
 */
const STARTS = ['06:00', '07:00', '08:00', '09:00', '10:00'];
const ENDS = ['16:00', '17:00', '18:00', '19:00', '20:00', '21:00'];

export default function DoNotDisturbScreen() {
  const [prefs, setPrefs] = useState<MyPrefs | null>(null);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchMyPrefs().then(setPrefs);
    }, []),
  );

  const update = async (patch: Partial<MyPrefs>) => {
    if (!prefs) return;
    const previous = prefs;
    setPrefs({ ...prefs, ...patch });
    setError(null);
    const result = await saveMyPrefs(patch);
    if (!result.ok) {
      setPrefs(previous);
      setError(result.message);
    }
  };

  if (!prefs) {
    return (
      <Screen edges={[]}>
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        <View style={styles.row}>
          <View style={styles.flex}>
            <AppText variant="heading">Do not disturb</AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              Outside your hours, calls don&apos;t ring. The caller gets a text saying you&apos;ll call back.
            </AppText>
          </View>
          <Switch value={prefs.dndEnabled} onValueChange={(v) => void update({ dndEnabled: v })} />
        </View>
      </Card>

      {prefs.dndEnabled ? (
        <>
          <Card style={styles.card}>
            <AppText variant="bodyStrong">Calls ring from</AppText>
            <View style={styles.chips}>
              {STARTS.map((t) => (
                <Chip key={t} label={hmLabel(t)} tone="ocean" selected={prefs.workStart === t} onPress={() => void update({ workStart: t })} />
              ))}
            </View>
            <AppText variant="bodyStrong" style={styles.gap}>
              Until
            </AppText>
            <View style={styles.chips}>
              {ENDS.map((t) => (
                <Chip key={t} label={hmLabel(t)} tone="ocean" selected={prefs.workEnd === t} onPress={() => void update({ workEnd: t })} />
              ))}
            </View>
          </Card>
          <AppText variant="caption" color={isAwayNow(prefs) ? colors.amberDeep : colors.mintDeep}>
            {isAwayNow(prefs)
              ? `Right now you're away — calls won't ring until ${hmLabel(prefs.workStart)}.`
              : `Right now calls ring as normal, until ${hmLabel(prefs.workEnd)}.`}
          </AppText>
          <AppText variant="caption" color={colors.textSecondary}>
            What callers get: &quot;Thanks for calling DC Solar! You&apos;re away right now and will call them back tomorrow
            morning.&quot; Each caller gets that text at most once every 12 hours.
          </AppText>
        </>
      ) : null}

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
  card: { gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  flex: { flex: 1, gap: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  gap: { marginTop: spacing.sm },
});
