import Ionicons from '@expo/vector-icons/Ionicons';
import { Redirect, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { presetProspectPhone } from '@/components/crm/workspace/ProspectForm';
import { Dialpad } from '@/components/phone/Dialpad';
import { AppText } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { fetchWorkspaceRecords, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { useRoleGate } from '@/lib/role';
import { fetchMyLine } from '@/lib/salesHome';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * The Keypad tab (2026-10-06) — a sales rep's dial pad.
 *
 * Every call goes out from THEIR DC Solar number (twilio-voice-outbound looks
 * the caller up in voice_routes), never their personal phone, so it only
 * dials in the DC Solar app or at app.dcsolarkc.com — the same rule as the
 * CRM's Call button. There is no bridge here: the bridge rings a cell first,
 * and reps do not keep one on file.
 *
 * WHO AM I DIALLING. As digits go in, the rep's OWN prospects, leads and
 * customers are matched by phone (the same RLS-scoped list the CRM shows —
 * `phone_directory()` is admin-only and returns nothing to them). A match is
 * named above the pad and the call is filed on that record; an unknown
 * number can be saved as a prospect.
 *
 * Admins and crew keep the Phone app's keypad (`/phone/keypad`); this tab is
 * hidden from them and sends them there if they land on it.
 */

function toE164(dialed: string): string | null {
  const trimmed = dialed.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export default function KeypadTab() {
  const gate = useRoleGate();
  if (gate.phase === 'ready' && !gate.role?.isSales) return <Redirect href="/phone/keypad" />;
  return <SalesKeypad />;
}

function SalesKeypad() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [line, setLine] = useState<string | null>(null);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [note, setNote] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.all([fetchMyLine(), fetchWorkspaceRecords()]).then(([l, r]) => {
        if (cancelled) return;
        setLine(l);
        setRecords(r.records);
      });
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const digits = value.replace(/[^0-9]/g, '');
  const e164 = toE164(value);
  const matches = useMemo(() => {
    if (digits.length < 4) return [];
    const exact = e164 ? records.filter((r) => r.phoneE164 === e164) : [];
    if (exact.length > 0) return exact;
    return records.filter((r) => r.phoneE164?.includes(digits)).slice(0, 3);
  }, [records, digits, e164]);
  const match = e164 ? (matches.find((r) => r.phoneE164 === e164) ?? null) : null;

  const call = () => {
    if (!e164) {
      setNote(digits.length > 0 ? 'Enter a full 10-digit number.' : null);
      return;
    }
    if (!inAppCallingSupported()) {
      // Never the phone's own dialer: it would show their PERSONAL number.
      setNote('Calls from your DC Solar number work in the DC Solar app or at app.dcsolarkc.com.');
      return;
    }
    const params: Record<string, string> = { to: e164, name: match?.name ?? formatPhone(e164) };
    if (match?.kind === 'customer') params.customerId = match.id;
    router.push({ pathname: '/call', params } as never);
  };

  const saveAsProspect = () => {
    if (!e164) return;
    presetProspectPhone(formatPhone(e164));
    router.navigate({ pathname: '/workspace', params: { new: 'prospect' } } as never);
  };

  // FIT ON ONE SCREEN (2026-10-07). The pad is 5 rows of keys (4 + call)
  // plus the number display and gaps, ≈ 6.8 × the key size. The free height
  // under the header is measured and the keys sized to it (44–76 pt), so it
  // never scrolls on an iPhone SE or spreads out on a big phone. One name
  // match (or one notice) sits in a fixed slot above, so nothing moves while
  // typing.
  const [freeHeight, setFreeHeight] = useState(0);
  const keySize = freeHeight > 0 ? Math.max(44, Math.min(76, Math.floor(freeHeight / 6.8))) : 64;
  const extra = matches.length - 1;

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.container}>
        <View style={styles.head}>
          <AppText variant="heading" color={colors.textPrimary}>
            Keypad
          </AppText>
          <AppText variant="caption" color={colors.textSecondary} numberOfLines={1}>
            {line ? `From your number ${formatPhone(line)}` : 'No DC Solar number yet — ask an admin'}
          </AppText>
        </View>

        <View style={styles.slot}>
          {note ? (
            <Text style={styles.note} numberOfLines={2}>
              {note}
            </Text>
          ) : matches[0] ? (
            <Pressable
              onPress={() => router.navigate({ pathname: '/workspace', params: { open: matches[0].key } } as never)}
              style={({ pressed }) => [styles.match, matches[0] === match && styles.matchPrimary, pressed && styles.pressed]}>
              <Ionicons name="person" size={16} color={hubColors.crm.fg} />
              <View style={styles.matchBody}>
                <Text style={styles.matchName} numberOfLines={1}>
                  {matches[0].name}
                </Text>
                <Text style={styles.matchMeta} numberOfLines={1}>
                  {matches[0].kind === 'customer' ? 'Customer' : 'Prospect / lead'}
                  {matches[0].phoneE164 ? ` · ${formatPhone(matches[0].phoneE164)}` : ''}
                  {extra > 0 ? ` · +${extra} more` : ''}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            </Pressable>
          ) : e164 ? (
            <Pressable onPress={saveAsProspect} style={({ pressed }) => [styles.save, pressed && styles.pressed]}>
              <Ionicons name="person-add-outline" size={15} color={hubColors.crm.fg} />
              <Text style={styles.saveText}>New number · Save as prospect</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.padArea} onLayout={(e) => setFreeHeight(e.nativeEvent.layout.height)}>
          <Dialpad
            value={value}
            onChange={(next) => {
              setValue(next);
              if (note) setNote(null);
            }}
            onCall={call}
            keySize={keySize}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  container: {
    flex: 1,
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    gap: spacing.sm,
  },
  head: { gap: 2 },
  slot: { height: 52, justifyContent: 'center' },
  padArea: { flex: 1, justifyContent: 'center' },
  match: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
    opacity: 0.8,
  },
  matchPrimary: { opacity: 1, backgroundColor: hubColors.crm.bg },
  matchBody: { flex: 1, gap: 1 },
  matchName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  matchMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  save: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    alignSelf: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  saveText: { color: hubColors.crm.fg, fontSize: 13, fontWeight: '800' },
  note: { color: colors.danger, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
