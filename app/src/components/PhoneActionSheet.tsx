import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';

/**
 * What you can do with a customer's phone number.
 *
 * PHASE 1 REALITY. Two of these four rows are deliberately dead. Calling and
 * texting from the DC Solar business number is Workstream G: it needs a Twilio
 * number, an A2P 10DLC campaign (1–5 business days for approval) and the
 * `twilio-*` edge functions. Showing the rows greyed out with "coming soon" is
 * the honest version — Devon can see where they will be, and nobody taps a
 * button that silently does nothing.
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
  isAdmin = false,
  optedOut = false,
  onClose,
}: {
  phone: string;
  /** The normalised +1XXXXXXXXXX, when the number could be parsed. */
  phoneE164?: string | null;
  name?: string | null;
  isAdmin?: boolean;
  /** The customer replied STOP — texting them is not an option at all. */
  optedOut?: boolean;
  onClose?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const dialable = phone.replace(/[^+\d]/g, '');

  const call = () => {
    Linking.openURL('tel:' + dialable).catch(() => {});
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
          <View style={styles.disabledRow}>
            <View style={styles.iconWrapMuted}>
              <Ionicons name="call" size={16} color={colors.inkSoft} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.disabledTitle}>Call via DC Solar</Text>
              <Text style={styles.disabledNote}>Coming soon — needs the Twilio number</Text>
            </View>
          </View>
          <View style={styles.disabledRow}>
            <View style={styles.iconWrapMuted}>
              <Ionicons name="chatbubble" size={16} color={colors.inkSoft} />
            </View>
            <View style={styles.rowBody}>
              <Text style={styles.disabledTitle}>Text via DC Solar</Text>
              <Text style={styles.disabledNote}>
                {optedOut
                  ? 'This customer replied STOP — we may not text them'
                  : 'Coming soon — waiting on A2P campaign approval'}
              </Text>
            </View>
          </View>
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
