import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { NOT_CONFIGURED_SMS, sendSms } from '@/lib/comms';

/**
 * A one-box text composer for anywhere that is not a customer's Comms tab:
 * the keypad, a supplier in Contacts, an unknown number expanded in the inbox.
 *
 * Deliberately small. The customer thread's composer (crm/[id].tsx) has
 * templates and pictures because that is where a real conversation happens;
 * this one exists so "text the supply house" is one tap, not a trip through
 * the CRM. It sends through the same `sendSms` → `twilio-send-sms` path, so
 * the server still decides whether the send is allowed and the row still
 * lands in the shared inbox.
 *
 * `smsReady` false shows the one honest sentence and no box at all — a
 * disabled Send button next to an editable field reads as "broken".
 */
export function QuickCompose({
  target,
  name,
  smsReady,
  optedOut = false,
  jobId,
  onSent,
  autoFocus = false,
}: {
  target: { customerId?: string; leadId?: string; contactId?: string; to?: string };
  name?: string | null;
  smsReady: boolean;
  optedOut?: boolean;
  jobId?: string | null;
  onSent?: () => void;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  if (optedOut) {
    return (
      <View style={styles.notice}>
        <Ionicons name="hand-left" size={14} color={colors.coralDeep} />
        <Text style={styles.noticeText}>They replied STOP — we may not text them. You can still call.</Text>
      </View>
    );
  }

  if (!smsReady) {
    return (
      <View style={[styles.notice, styles.noticeMuted]}>
        <Ionicons name="construct" size={14} color={colors.slateDeep} />
        <Text style={styles.noticeText}>{NOT_CONFIGURED_SMS}</Text>
      </View>
    );
  }

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setNote(null);
    const result = await sendSms({
      customerId: target.customerId,
      leadId: target.leadId,
      contactId: target.contactId,
      to: target.to,
      body,
      jobId: jobId ?? undefined,
    });
    setSending(false);
    if (result.ok) {
      setDraft('');
      setNote({ kind: 'ok', text: 'Sent — replies land in Messages.' });
      onSent?.();
    } else {
      setNote({ kind: 'error', text: result.message });
    }
  };

  const placeholder = name ? `Text ${name.split(' ')[0] ?? name}` : 'Text this number';

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={colors.inkSoft}
          multiline
          autoFocus={autoFocus}
          style={styles.input}
        />
        <Pressable
          onPress={() => void send()}
          disabled={sending || draft.trim().length === 0}
          accessibilityLabel="Send text"
          style={({ pressed }) => [
            styles.send,
            (pressed || sending || draft.trim().length === 0) && styles.pressed,
          ]}>
          {sending ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Ionicons name="send" size={16} color={colors.ink} />
          )}
        </Pressable>
      </View>
      {note ? (
        <Text style={[styles.note, note.kind === 'error' ? styles.noteError : styles.noteOk]}>
          {note.text}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
  input: {
    flex: 1,
    maxHeight: 110,
    backgroundColor: colors.canvas,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.sun,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.6 },
  note: { fontSize: 12, fontWeight: '700' },
  noteOk: { color: colors.success },
  noteError: { color: colors.danger },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.coralSoft,
    borderRadius: radii.md,
    padding: spacing.sm + 2,
  },
  noticeMuted: { backgroundColor: colors.slateSoft },
  noticeText: { flex: 1, color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
});
