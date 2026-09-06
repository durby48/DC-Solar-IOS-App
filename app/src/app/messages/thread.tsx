import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Conversation } from '@/components/comms/Conversation';
import { colors, radii, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_VOICE,
  fetchCommsSettings,
  fetchContactById,
  fetchMyStaffProfile,
  fetchTemplates,
  formatPhone,
  placeBridgeCall,
  buildTemplateVars,
  type CommsSettings,
  type MessageTemplate,
  type StaffProfile,
} from '@/lib/comms';
import { fetchCustomerById } from '@/lib/crm';
import { useRole } from '@/lib/role';
import { type Customer } from '@/lib/types';

/**
 * `/messages/thread` — one conversation, pushed over everything like a
 * phone's Messages app does. The inbox, the keypad, Contacts and Recents all
 * land here.
 *
 * Who the far end is comes in as params: `customerId`, `contactId`,
 * `leadId`, or just `phone` for a stranger, plus a `name` so the header can
 * be right before anything loads. A customer is re-read so the STOP flag and
 * the ⓘ → CRM link are current; everything else trusts the params.
 *
 * The body is `components/comms/Conversation.tsx` — the same component the
 * customer record's Comms segment renders.
 */
export default function ThreadScreen() {
  const router = useRouter();
  const role = useRole();
  const params = useLocalSearchParams<{
    customerId?: string;
    contactId?: string;
    leadId?: string;
    phone?: string;
    name?: string;
  }>();
  const customerId = typeof params.customerId === 'string' ? params.customerId : null;
  const contactId = typeof params.contactId === 'string' ? params.contactId : null;
  const leadId = typeof params.leadId === 'string' ? params.leadId : null;
  const paramPhone = typeof params.phone === 'string' ? params.phone : null;
  const paramName = typeof params.name === 'string' ? params.name : null;

  const [loading, setLoading] = useState(true);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [contactName, setContactName] = useState<string | null>(null);
  const [contactPhone, setContactPhone] = useState<string | null>(null);
  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [callBusy, setCallBusy] = useState(false);
  const [callNote, setCallNote] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      void (async () => {
        const [s, p, t, c, k] = await Promise.all([
          fetchCommsSettings(),
          fetchMyStaffProfile(),
          fetchTemplates(),
          customerId ? fetchCustomerById(customerId) : Promise.resolve(null),
          contactId ? fetchContactById(contactId) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setSettings(s);
        setProfile(p);
        setTemplates(t);
        setCustomer(c);
        setContactName(k?.name ?? null);
        setContactPhone(k?.phoneE164 ?? null);
        setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }, [customerId, contactId]),
  );

  const phone = customer?.phone_e164 ?? contactPhone ?? paramPhone;
  const name =
    customer?.name ?? contactName ?? paramName ?? (phone ? formatPhone(phone) : 'Conversation');
  const optedOut = customer?.sms_opt_out_at != null;
  const smsReady = settings?.smsEnabled === true;
  const voiceReady = settings?.voiceEnabled === true;
  const hasStaffNumber = Boolean(profile?.cellPhoneE164);
  const canCall = voiceReady && hasStaffNumber && Boolean(phone);
  const stranger = !customerId && !contactId && !leadId;

  const startCall = async () => {
    if (!canCall || callBusy) {
      setCallNote(
        !voiceReady
          ? NOT_CONFIGURED_VOICE
          : !hasStaffNumber
            ? 'Add your cell number in Messages settings — that is the phone we ring first.'
            : 'No number to dial.',
      );
      return;
    }
    setCallBusy(true);
    setCallNote('Ringing your cell…');
    const result = await placeBridgeCall({
      customerId: customerId ?? undefined,
      contactId: contactId ?? undefined,
      to: customerId || contactId ? undefined : (phone ?? undefined),
    });
    setCallBusy(false);
    setCallNote(result.ok ? 'Pick up your phone — we are dialling them next.' : result.message);
  };

  const header = (
    <>
      <Stack.Screen
        options={{
          title: name,
          headerRight: () =>
            customerId ? (
              <Pressable
                onPress={() => router.push({ pathname: '/crm/[id]', params: { id: customerId } })}
                hitSlop={8}
                accessibilityLabel="Open customer record"
                style={({ pressed }) => pressed && styles.pressed}>
                <Ionicons name="information-circle-outline" size={24} color={colors.ocean} />
              </Pressable>
            ) : null,
        }}
      />
      <View style={styles.topBar}>
        <View style={styles.topBarBody}>
          <Text style={styles.topBarText} numberOfLines={1}>
            {phone ? formatPhone(phone) : 'No phone number on file'}
            {smsReady && settings?.fromNumber ? ` · from ${formatPhone(settings.fromNumber)}` : ''}
          </Text>
          {callNote ? <Text style={styles.topBarNote}>{callNote}</Text> : null}
        </View>
        <Pressable
          onPress={() => void startCall()}
          disabled={callBusy}
          style={({ pressed }) => [
            styles.callButton,
            !canCall && styles.callButtonMuted,
            (pressed || callBusy) && styles.pressed,
          ]}>
          {callBusy ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <>
              <Ionicons name="call" size={14} color={canCall ? colors.ink : colors.inkSoft} />
              <Text style={[styles.callButtonText, !canCall && styles.callButtonTextMuted]}>Call</Text>
            </>
          )}
        </Pressable>
      </View>
      {stranger && phone && role?.isAdmin ? (
        <Pressable
          onPress={() => router.push('/customers')}
          style={({ pressed }) => [styles.strangerBar, pressed && styles.pressed]}>
          <Ionicons name="person-add" size={14} color={colors.ocean} />
          <Text style={styles.strangerText}>
            Not in the CRM. Add them as a customer with {formatPhone(phone)} and this thread attaches
            to the record.
          </Text>
        </Pressable>
      ) : null}
    </>
  );

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: paramName ?? 'Conversation' }} />
        <View style={styles.center}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      </>
    );
  }

  return (
    <Conversation
      target={{ customerId, contactId, leadId, phone }}
      name={name}
      smsReady={smsReady && Boolean(phone || customerId || contactId || leadId)}
      optedOut={optedOut}
      optedOutAt={customer?.sms_opt_out_at ?? null}
      templates={templates}
      templateVars={buildTemplateVars({
        customer: customer ?? (contactName ? { name: contactName } : null),
        settings,
        tech: role?.displayName ?? null,
      })}
      banner={header}
      autoFocus
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cream },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  topBarBody: { flex: 1, gap: 1 },
  topBarText: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  topBarNote: { color: colors.ocean, fontSize: 12, fontWeight: '700' },
  callButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  callButtonMuted: { backgroundColor: colors.slateSoft },
  callButtonText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  callButtonTextMuted: { color: colors.inkSoft },
  strangerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.xs,
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.sm + 2,
  },
  strangerText: { flex: 1, color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
