import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { NOT_CONFIGURED_SMS, NOT_CONFIGURED_VOICE, placeBridgeCall } from '@/lib/comms';

/**
 * What you can do with a customer's phone number.
 *
 * FOUR ROWS, TWO WORLDS. "Call via DC Solar" and "Text via DC Solar" go
 * through the business number — the customer sees the company, not somebody's
 * personal cell, and the reply lands in the shared inbox where the whole
 * office can see it. "Call from my phone" and "Copy number" are the fallbacks,
 * and they stay available forever: a bridge call needs Twilio to be up and a
 * roof in Raytown needs the call to happen either way.
 *
 * THE DC SOLAR ROWS DISABLE THEMSELVES rather than failing on tap. Twilio is
 * not connected yet (every send returns 503 `not_configured`), so the caller
 * passes `smsReady`/`voiceReady` from `comms_settings` and the rows say what
 * is missing. Once Devon finishes docs/TWILIO_SETUP.md and flips the switches,
 * the same rows come alive with no code change.
 *
 * A BRIDGE CALL RINGS YOUR OWN PHONE FIRST. That is why the row shows
 * "Ringing your cell…" while it is in flight — without it the first person to
 * press it assumes nothing happened and presses it again.
 *
 * COPY. `expo-clipboard` is NOT installed and React Native's own `Clipboard`
 * is deprecated; adding either would force a full App Store build for one
 * convenience button. So: `navigator.clipboard` on web, and on the phone the
 * number is `selectable` so a long-press copies it — exactly what
 * `app/security.tsx` does with the 2FA secret.
 */
export function PhoneActionSheet({
  phone,
  phoneE164,
  name,
  customerId,
  jobId,
  isAdmin = false,
  optedOut = false,
  smsReady = false,
  voiceReady = false,
  hasStaffNumber = true,
  onText,
  onClose,
}: {
  phone: string;
  /** The normalised +1XXXXXXXXXX, when the number could be parsed. */
  phoneE164?: string | null;
  name?: string | null;
  /** Lets the bridge call attach itself to the right customer's thread. */
  customerId?: string | null;
  jobId?: string | null;
  isAdmin?: boolean;
  /** The customer replied STOP — texting them is not an option at all. */
  optedOut?: boolean;
  /** `comms_settings.sms_enabled` — false until Twilio is connected. */
  smsReady?: boolean;
  /** `comms_settings.voice_enabled`. */
  voiceReady?: boolean;
  /** Whether I have saved a cell number for the bridge to ring. */
  hasStaffNumber?: boolean;
  /** Opens the Comms thread. Without it the Text row has nowhere to go. */
  onText?: () => void;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [calling, setCalling] = useState(false);
  const [callNote, setCallNote] = useState<string | null>(null);

  const dialable = phone.replace(/[^+\d]/g, '');

  const call = () => {
    Linking.openURL('tel:' + dialable).catch(() => {});
  };

  const canBridge = voiceReady && hasStaffNumber;
  const canText = smsReady && !optedOut && Boolean(onText);

  const bridgeNote = !voiceReady
    ? NOT_CONFIGURED_VOICE
    : !hasStaffNumber
      ? 'Add your cell number in Messages settings'
      : 'Rings your cell, then dials them from the DC Solar number';

  const textNote = optedOut
    ? 'This customer replied STOP — we may not text them'
    : !smsReady
      ? NOT_CONFIGURED_SMS
      : 'Opens the shared thread — replies land in Messages';

  const startBridge = async () => {
    setCalling(true);
    setCallNote('Ringing your cell…');
    const result = await placeBridgeCall({
      customerId: customerId ?? undefined,
      to: customerId ? undefined : (phoneE164 ?? phone),
      jobId: jobId ?? undefined,
    });
    setCalling(false);
    setCallNote(
      result.ok ? 'Pick up your phone — we are dialling them next.' : result.message,
    );
  };

  const copy = async () => {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(phoneE164 ?? phone);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Clipboard blocked (insecure context): the number is selectable anyway.
      }
    }
  };

  return (
    <View style={styles.sheet}>
      <View style={styles.headerRow}>
        <View style={styles.headerBody}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {name ? name : 'Phone'}
          </Text>
          <Text style={styles.headerNumber} selectable>
            {phone}
          </Text>
        </View>
        {onClose ? (
          <Pressable onPress={onClose} hitSlop={8} style={({ pressed }) => pressed && styles.pressed}>
            <Ionicons name="close" size={20} color={colors.inkSoft} />
          </Pressable>
        ) : null}
      </View>

      {isAdmin ? (
        <>
          <Pressable
            onPress={() => (canBridge ? void startBridge() : undefined)}
            disabled={!canBridge || calling}
            style={({ pressed }) => [
              canBridge ? styles.actionRow : styles.disabledRow,
              pressed && canBridge && styles.rowPressed,
            ]}>
            <View style={canBridge ? styles.iconWrap : styles.iconWrapMuted}>
              {calling ? (
                <ActivityIndicator color={colors.ocean} size="small" />
              ) : (
                <Ionicons name="call" size={16} color={canBridge ? colors.ocean : colors.inkSoft} />
              )}
            </View>
            <View style={styles.rowBody}>
              <Text style={canBridge ? styles.actionTitle : styles.disabledTitle}>
                Call via DC Solar
              </Text>
              <Text style={canBridge ? styles.actionNote : styles.disabledNote}>
                {callNote ?? bridgeNote}
              </Text>
            </View>
            {canBridge && !calling ? (
              <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
            ) : null}
          </Pressable>

          <Pressable
            onPress={() => (canText ? onText?.() : undefined)}
            disabled={!canText}
            style={({ pressed }) => [
              canText ? styles.actionRow : styles.disabledRow,
              pressed && canText && styles.rowPressed,
            ]}>
            <View style={canText ? styles.iconWrap : styles.iconWrapMuted}>
              <Ionicons
                name="chatbubble"
                size={16}
                color={canText ? colors.ocean : colors.inkSoft}
              />
            </View>
            <View style={styles.rowBody}>
              <Text style={canText ? styles.actionTitle : styles.disabledTitle}>
                Text via DC Solar
              </Text>
              <Text style={canText ? styles.actionNote : styles.disabledNote}>{textNote}</Text>
            </View>
            {canText ? <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} /> : null}
          </Pressable>
        </>
      ) : null}

      <Pressable
        onPress={call}
        style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}>
        <View style={styles.iconWrap}>
          <Ionicons name="phone-portrait" size={16} color={colors.ocean} />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.actionTitle}>Call from my phone</Text>
          <Text style={styles.actionNote}>Your own number shows as the caller ID</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
      </Pressable>

      <Pressable
        onPress={() => void copy()}
        style={({ pressed }) => [styles.actionRow, pressed && styles.rowPressed]}>
        <View style={styles.iconWrap}>
          <Ionicons name={copied ? 'checkmark' : 'copy'} size={16} color={colors.ocean} />
        </View>
        <View style={styles.rowBody}>
          <Text style={styles.actionTitle}>{copied ? 'Copied' : 'Copy number'}</Text>
          <Text style={styles.actionNote}>
            {Platform.OS === 'web'
              ? (phoneE164 ?? phone)
              : 'Long-press the number above to copy it'}
          </Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: colors.canvas,
    borderRadius: radii.md,
    padding: spacing.sm,
    gap: spacing.xs,
    borderWidth: 1,
    borderColor: colors.line,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xs,
    paddingBottom: spacing.xs,
  },
  headerBody: { flex: 1, gap: 2 },
  headerTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  headerNumber: { color: colors.inkSoft, fontSize: 14, fontWeight: '600' },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  disabledRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    padding: spacing.sm,
    opacity: 0.55,
  },
  rowBody: { flex: 1, gap: 1 },
  actionTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  actionNote: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  disabledTitle: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  disabledNote: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  iconWrap: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapMuted: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.slateSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowPressed: { backgroundColor: colors.skySoft },
  pressed: { opacity: 0.7 },
});
