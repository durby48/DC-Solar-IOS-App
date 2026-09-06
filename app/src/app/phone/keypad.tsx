import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { Dialpad } from '@/components/phone/Dialpad';
import { colors, radii, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_VOICE,
  fetchCommsSettings,
  fetchDirectory,
  fetchMyStaffProfile,
  formatPhone,
  matchDirectory,
  placeBridgeCall,
  saveMyCellPhone,
  type CommsSettings,
  type DirectoryEntry,
  type StaffProfile,
} from '@/lib/comms';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * Phone → Keypad. The default tab.
 *
 * WHO AM I DIALLING. Under the number, the directory is matched live as you
 * type, so calling a known customer from the keypad still logs against their
 * record — `placeBridgeCall` gets their `customerId` (or a supplier's
 * `contactId`) rather than a bare number, and the call lands in the right
 * thread instead of creating a stranger. If several records share the
 * number, the first is used and the rest are listed so the mistake is
 * visible rather than silent.
 *
 * EVERY CALL GOES THROUGH TWILIO. A bridge call rings YOUR cell first, then
 * dials the customer with the DC Solar number as caller ID — so Twilio has
 * to know which phone to ring. If this account has not saved one yet, the
 * first tap on Call asks for it right here (one field, saved to
 * staff_profiles, same as Messages settings), and then places the call. The
 * button never greys out for that: a dead button next to "not in the
 * directory" read as "you can't dial strangers", which was never true.
 */

function toE164(dialed: string): string | null {
  const trimmed = dialed.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

const SOURCE_LABEL: Record<DirectoryEntry['source'], string> = {
  customer: 'Customer',
  lead: 'Lead',
  crew: 'Crew',
  contact: 'Supplier',
};

export default function KeypadScreen() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [calling, setCalling] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  // One-time setup, shown on the first Call when no cell number is saved.
  const [setupOpen, setSetupOpen] = useState(false);
  const [cellDraft, setCellDraft] = useState('');
  const [savingCell, setSavingCell] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void Promise.all([fetchCommsSettings(), fetchMyStaffProfile(), fetchDirectory()]).then(
        ([s, p, d]) => {
          if (cancelled) return;
          setSettings(s);
          setProfile(p);
          setDirectory(d);
        },
      );
      return () => {
        cancelled = true;
      };
    }, []),
  );

  const matches = useMemo(() => matchDirectory(directory, value), [directory, value]);
  const primary = matches[0] ?? null;
  const e164 = primary?.phoneE164 ?? toE164(value);

  const voiceReady = settings?.voiceEnabled === true;
  const hasStaffNumber = Boolean(profile?.cellPhoneE164);
  const canCall = voiceReady && hasStaffNumber;

  const gateNote = !voiceReady
    ? NOT_CONFIGURED_VOICE
    : !hasStaffNumber && !inAppCallingSupported()
      ? 'Calls go out on the DC Solar number. Twilio rings your cell first, then connects them — tap Call and it will ask for your cell once.'
      : null;

  /**
   * Place the call. On the web the app calls them itself (the active-call
   * screen); on the phone, until Phase 4, the Twilio bridge rings your cell
   * first and then dials them as DC Solar.
   */
  const placeCall = async (to: string) => {
    if (inAppCallingSupported()) {
      const callParams: Record<string, string> = { to, name: primary?.displayName ?? formatPhone(to) };
      if (primary?.source === 'customer') callParams.customerId = primary.id;
      else if (primary?.source === 'contact') callParams.contactId = primary.id;
      router.push({ pathname: '/call', params: callParams } as never);
      return;
    }
    setCalling(true);
    setNote({ kind: 'info', text: 'Ringing your cell…' });
    const result = await placeBridgeCall({
      customerId: primary?.source === 'customer' ? primary.id : undefined,
      contactId: primary?.source === 'contact' ? primary.id : undefined,
      to: primary?.source === 'customer' || primary?.source === 'contact' ? undefined : to,
    });
    setCalling(false);
    setNote(
      result.ok
        ? { kind: 'ok', text: 'Pick up your phone — we are dialling them next.' }
        : { kind: 'error', text: result.message },
    );
  };

  const call = async () => {
    if (calling || savingCell) return;
    if (!e164) {
      setNote({ kind: 'error', text: `"${value}" is not a number we can dial.` });
      return;
    }
    if (!voiceReady) {
      setNote({ kind: 'error', text: NOT_CONFIGURED_VOICE });
      return;
    }
    // The bridge needs a cell to ring first; the in-app call does not.
    if (!hasStaffNumber && !inAppCallingSupported()) {
      setSetupOpen(true);
      setNote(null);
      return;
    }
    await placeCall(e164);
  };

  /**
   * Save the cell Twilio should ring, then place the call that was tapped.
   * Writes `staff_profiles` — the same row Messages settings edits — so it is
   * asked exactly once.
   */
  const saveCellAndCall = async () => {
    const digits = cellDraft.replace(/[^0-9]/g, '');
    if (!(digits.length === 10 || (digits.length === 11 && digits.startsWith('1')))) {
      setNote({ kind: 'error', text: 'Enter a 10-digit US cell number.' });
      return;
    }
    setSavingCell(true);
    const saved = await saveMyCellPhone(cellDraft.trim());
    if (!saved.ok) {
      setSavingCell(false);
      setNote({ kind: 'error', text: saved.message });
      return;
    }
    const fresh = await fetchMyStaffProfile();
    setProfile(fresh);
    setSavingCell(false);
    if (!fresh?.cellPhoneE164) {
      setNote({ kind: 'error', text: 'That number did not save as a US cell. Check it and try again.' });
      return;
    }
    setSetupOpen(false);
    if (e164) await placeCall(e164);
  };

  const openRecord = (entry: DirectoryEntry) => {
    if (entry.source === 'customer') {
      router.push({ pathname: '/crm/[id]', params: { id: entry.id } });
    } else if (entry.source === 'lead') {
      router.push({ pathname: '/leads/[id]', params: { id: entry.id } } as never);
    }
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled">
      {gateNote ? (
        <Pressable
          onPress={() => (!hasStaffNumber && voiceReady ? router.push('/crm/settings') : undefined)}
          style={({ pressed }) => [styles.gate, pressed && styles.pressed]}>
          <Ionicons name="construct" size={16} color={colors.slateDeep} />
          <Text style={styles.gateText}>{gateNote}</Text>
          {!hasStaffNumber && voiceReady ? (
            <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
          ) : null}
        </Pressable>
      ) : null}

      {/* Who this number already is. Shown above the pad so it reads before
          the thumb reaches the call button. */}
      <View style={styles.matchArea}>
        {matches.length > 0 ? (
          matches.map((entry, index) => (
            <Pressable
              key={`${entry.source}:${entry.id}`}
              onPress={() => openRecord(entry)}
              disabled={entry.source !== 'customer' && entry.source !== 'lead'}
              style={({ pressed }) => [
                styles.match,
                index === 0 && styles.matchPrimary,
                pressed && styles.pressed,
              ]}>
              <Ionicons
                name={entry.source === 'crew' ? 'hammer' : entry.source === 'contact' ? 'storefront' : 'person'}
                size={16}
                color={colors.ocean}
              />
              <View style={styles.matchBody}>
                <Text style={styles.matchName} numberOfLines={1}>
                  {entry.displayName}
                </Text>
                <Text style={styles.matchMeta} numberOfLines={1}>
                  {SOURCE_LABEL[entry.source]}
                  {entry.subtitle ? ` · ${entry.subtitle}` : ''}
                  {entry.phoneE164 ? ` · ${formatPhone(entry.phoneE164)}` : ''}
                </Text>
              </View>
              {entry.source === 'customer' || entry.source === 'lead' ? (
                <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
              ) : null}
            </Pressable>
          ))
        ) : value.replace(/[^0-9]/g, '').length >= 4 ? (
          <Text style={styles.matchHint}>Not in the directory — dials as a new number.</Text>
        ) : null}
      </View>

      <Dialpad
        value={value}
        onChange={(next) => {
          setValue(next);
          if (note) setNote(null);
        }}
        onCall={() => void call()}
        callBusy={calling || savingCell}
      />

      {setupOpen && !canCall ? (
        <View style={styles.setup}>
          <Text style={styles.setupTitle}>Which phone should Twilio ring?</Text>
          <Text style={styles.setupBody}>
            Calls go out on the DC Solar number. Twilio rings your cell first, then connects{' '}
            {primary?.displayName ?? (e164 ? formatPhone(e164) : 'them')} — they see (816)
            744-6473, never your number. Asked once; change it any time in Messages settings.
          </Text>
          <TextInput
            value={cellDraft}
            onChangeText={setCellDraft}
            placeholder="Your cell, e.g. (816) 555-0100"
            placeholderTextColor={colors.inkSoft}
            keyboardType="phone-pad"
            autoFocus
            style={styles.setupInput}
          />
          <View style={styles.setupButtons}>
            <Pressable
              onPress={() => setSetupOpen(false)}
              style={({ pressed }) => [styles.setupCancel, pressed && styles.pressed]}>
              <Text style={styles.setupCancelText}>Not now</Text>
            </Pressable>
            <Pressable
              onPress={() => void saveCellAndCall()}
              disabled={savingCell}
              style={({ pressed }) => [styles.setupSave, (pressed || savingCell) && styles.pressed]}>
              {savingCell ? (
                <ActivityIndicator color={colors.ink} size="small" />
              ) : (
                <Text style={styles.setupSaveText}>Save & call</Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}

      {note ? (
        <Text
          style={[
            styles.note,
            note.kind === 'error' ? styles.noteError : note.kind === 'ok' ? styles.noteOk : null,
          ]}>
          {note.text}
        </Text>
      ) : null}

      {e164 ? (
        <View style={styles.textArea}>
          <Pressable
            onPress={() => {
              const params: Record<string, string> = {
                phone: e164,
                name: primary?.displayName ?? formatPhone(e164),
              };
              if (primary?.source === 'customer') params.customerId = primary.id;
              else if (primary?.source === 'contact') params.contactId = primary.id;
              else if (primary?.source === 'lead') params.leadId = primary.id;
              router.push({ pathname: '/messages/thread', params } as never);
            }}
            style={({ pressed }) => [styles.textButton, pressed && styles.pressed]}>
            <Ionicons name="chatbubble" size={15} color={colors.ocean} />
            <Text style={styles.textButtonLabel}>
              Text {primary ? primary.displayName.split(' ')[0] : formatPhone(e164)} instead
            </Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },
  gate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.slateSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  gateText: { flex: 1, color: colors.inkSoft, fontSize: 13, fontWeight: '600' },
  matchArea: { minHeight: 44, gap: spacing.xs, justifyContent: 'flex-end' },
  match: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.sm + 2,
    opacity: 0.8,
  },
  matchPrimary: { opacity: 1, backgroundColor: colors.skySoft },
  matchBody: { flex: 1, gap: 1 },
  matchName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  matchMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  matchHint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', textAlign: 'center' },
  note: { color: colors.ocean, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  noteOk: { color: colors.success },
  noteError: { color: colors.danger },
  textArea: { paddingTop: spacing.sm },
  textButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    alignSelf: 'center',
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  textButtonLabel: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  setup: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  setupTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  setupBody: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  setupInput: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
  },
  setupButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  setupCancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.pill },
  setupCancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  setupSave: {
    backgroundColor: colors.sun,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    minWidth: 110,
    alignItems: 'center',
  },
  setupSaveText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
