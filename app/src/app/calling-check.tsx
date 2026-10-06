import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { AppText, Button, Card, Screen } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { fetchMyPrefs, hmLabel, isAwayNow, requestTestCall, type MyPrefs } from '@/lib/repSettings';
import { fetchMyLine } from '@/lib/salesHome';
import { getIncomingRegistration, inAppCallingSupported, registerForIncomingCalls } from '@/lib/voice';

/**
 * `/calling-check` (2026-10-06, rep Settings): why might calls not ring?
 * Four checks, each green or amber with what to do:
 *   1. a DC Solar number is assigned
 *   2. this device can make calls from it (the DC Solar app, or the website)
 *   3. this device is registered to RING for incoming calls (iPhone app only;
 *      the result of the last registration this session — Home runs it)
 *   4. Do not disturb is not holding calls right now
 * and "Send me a test call": Twilio calls their own number the way a customer
 * would (voice-test-call), so answering it proves the whole path.
 */
type Check = { ok: boolean; title: string; detail: string };

export default function CallingCheckScreen() {
  const [line, setLine] = useState<string | null | undefined>(undefined);
  const [prefs, setPrefs] = useState<MyPrefs | null>(null);
  const [registration, setRegistration] = useState(getIncomingRegistration());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  useFocusEffect(
    useCallback(() => {
      void fetchMyLine().then(setLine);
      void fetchMyPrefs().then(setPrefs);
      if (Platform.OS !== 'web') {
        // Re-register now so the answer is current, not from app launch.
        void registerForIncomingCalls().then(() => setRegistration(getIncomingRegistration()));
      }
    }, []),
  );

  const native = Platform.OS !== 'web';
  const checks: Check[] = [
    line
      ? { ok: true, title: 'DC Solar number', detail: `${formatPhone(line)} is yours.` }
      : { ok: false, title: 'DC Solar number', detail: line === null ? 'You do not have one yet — ask an admin.' : 'Checking…' },
    inAppCallingSupported()
      ? { ok: true, title: 'Making calls', detail: native ? 'This phone calls from your DC Solar number.' : 'This browser calls from your DC Solar number.' }
      : { ok: false, title: 'Making calls', detail: 'Use the DC Solar app or app.dcsolarkc.com — this page cannot use the microphone.' },
    native
      ? registration?.result.ok
        ? { ok: true, title: 'Receiving calls', detail: 'This phone is set up to ring when someone calls your number.' }
        : {
            ok: false,
            title: 'Receiving calls',
            detail: registration
              ? `Not set up: ${registration.result.ok ? '' : registration.result.message} Close and reopen the app; if it stays, tell an admin.`
              : 'Checking…',
          }
      : { ok: false, title: 'Receiving calls', detail: 'Calls only ring in the DC Solar iPhone app, not in a browser.' },
    prefs && isAwayNow(prefs)
      ? { ok: false, title: 'Do not disturb', detail: `On — calls will not ring until ${hmLabel(prefs.workStart)}.` }
      : { ok: true, title: 'Do not disturb', detail: prefs?.dndEnabled ? `On, but you are within your hours.` : 'Off.' },
  ];

  const test = async () => {
    setBusy(true);
    setNote(null);
    const result = await requestTestCall();
    setBusy(false);
    setNote(
      result.ok
        ? {
            ok: !result.away,
            text: result.away
              ? 'Calling your number now — but Do not disturb is holding calls, so it will not ring.'
              : 'Calling your number now. Answer it on this phone — you will hear a short message.',
          }
        : { ok: false, text: result.message },
    );
  };

  return (
    <Screen edges={[]} contentContainerStyle={styles.content}>
      <Card style={styles.card}>
        {checks.map((c, i) => (
          <View key={c.title} style={[styles.row, i < checks.length - 1 && styles.divider]}>
            <Ionicons name={c.ok ? 'checkmark-circle' : 'alert-circle'} size={22} color={c.ok ? colors.mintDeep : colors.amberDeep} />
            <View style={styles.flex}>
              <AppText variant="bodyStrong">{c.title}</AppText>
              <AppText variant="caption" color={colors.textSecondary}>
                {c.detail}
              </AppText>
            </View>
          </View>
        ))}
      </Card>
      <Button label="Send me a test call" icon="call" fullWidth loading={busy} disabled={!line} onPress={() => void test()} />
      {note ? (
        <AppText variant="caption" color={note.ok ? colors.mintDeep : colors.amberDeep}>
          {note.text}
        </AppText>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: spacing.md, paddingBottom: spacing.xl },
  card: { paddingVertical: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.sm },
  divider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  flex: { flex: 1, gap: 2 },
});
