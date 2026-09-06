import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_VOICE,
  fetchCommsSettings,
  fetchMyStaffProfile,
  fetchRecents,
  formatDuration,
  formatPhone,
  placeBridgeCall,
  useCommsRealtime,
  type CommsSettings,
  type RecentCall,
  type StaffProfile,
} from '@/lib/comms';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * Phone → Recents. The call log, newest first, folded like iOS.
 *
 * NO NEW TABLES. Every row here is a `messages` row with `channel = 'call'`
 * that `twilio-call` already writes and `twilio-status` already updates with
 * the outcome and duration. `fetchRecents` folds consecutive calls to the
 * same party into one row with a count.
 *
 * BE HONEST ABOUT "MISSED". Until in-app calling ships (Phase 4) the DC Solar
 * number cannot receive a call at all, so there is no such thing as a missed
 * inbound call yet. The Missed segment shows OUTBOUND bridge calls that did
 * not connect — failed, busy, no answer, cancelled — and says so, rather than
 * shipping a tab that is always empty.
 *
 * Tap a row to redial; ⓘ opens the customer's record.
 */

function when(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const withinWeek = now.getTime() - date.getTime() < 6 * 24 * 3600 * 1000;
  if (withinWeek) return date.toLocaleDateString('en-US', { weekday: 'short' });
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function outcome(call: RecentCall): string {
  const parts: string[] = [];
  parts.push(call.direction === 'out' ? 'Outgoing' : 'Incoming');
  if (call.missed) {
    parts.push(
      call.status === 'busy'
        ? 'busy'
        : call.status === 'no-answer'
          ? 'no answer'
          : call.status === 'canceled'
            ? 'cancelled'
            : 'did not connect',
    );
  } else if (call.durationSeconds) {
    parts.push(formatDuration(call.durationSeconds));
  } else if (call.status && call.status !== 'completed') {
    parts.push(call.status);
  }
  return parts.join(' · ');
}

export default function RecentsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [calls, setCalls] = useState<RecentCall[]>([]);
  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [segment, setSegment] = useState<'all' | 'missed'>('all');
  const [redialId, setRedialId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [rows, s, p] = await Promise.all([
      fetchRecents(),
      fetchCommsSettings(),
      fetchMyStaffProfile(),
    ]);
    setCalls(rows);
    setSettings(s);
    setProfile(p);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // A call's outcome arrives on twilio-status seconds after it ends; the
  // realtime channel is how "ringing" turns into "2m 14s" without a pull.
  useCommsRealtime(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const visible = useMemo(
    () => (segment === 'missed' ? calls.filter((c) => c.missed) : calls),
    [calls, segment],
  );

  const voiceReady = settings?.voiceEnabled === true;
  const hasStaffNumber = Boolean(profile?.cellPhoneE164);
  const canCall = voiceReady && hasStaffNumber;

  const redial = async (call: RecentCall) => {
    if (redialId) return;
    if (!call.customerId && !call.contactId && !call.phone) return;
    if (voiceReady && inAppCallingSupported() && call.phone) {
      const callParams: Record<string, string> = { to: call.phone, name: call.displayName };
      if (call.customerId) callParams.customerId = call.customerId;
      else if (call.contactId) callParams.contactId = call.contactId;
      router.push({ pathname: '/call', params: callParams } as never);
      return;
    }
    if (!canCall) {
      setNote({
        kind: 'error',
        text: !voiceReady
          ? NOT_CONFIGURED_VOICE
          : 'Twilio rings your cell first — tap Call on the Keypad once to save it, or add it in Messages settings.',
      });
      return;
    }
    setRedialId(call.id);
    setNote({ kind: 'info', text: `Ringing your cell, then ${call.displayName}…` });
    const result = await placeBridgeCall({
      customerId: call.customerId ?? undefined,
      contactId: call.contactId ?? undefined,
      to: call.customerId || call.contactId ? undefined : (call.phone ?? undefined),
    });
    setRedialId(null);
    setNote(
      result.ok
        ? { kind: 'ok', text: 'Pick up your phone — we are dialling them next.' }
        : { kind: 'error', text: result.message },
    );
    if (result.ok) void load();
  };

  const renderCall = ({ item }: { item: RecentCall }) => (
    <Pressable
      onPress={() => void redial(item)}
      disabled={redialId !== null}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={[styles.iconWrap, item.missed && styles.iconWrapMissed]}>
        {redialId === item.id ? (
          <ActivityIndicator color={colors.ocean} size="small" />
        ) : (
          <Ionicons
            name={item.direction === 'out' ? 'arrow-up-outline' : 'arrow-down-outline'}
            size={16}
            color={item.missed ? colors.danger : colors.ocean}
          />
        )}
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowTitleLine}>
          <Text style={[styles.rowName, item.missed && styles.rowNameMissed]} numberOfLines={1}>
            {item.displayName}
          </Text>
          {item.count > 1 ? <Text style={styles.count}>×{item.count}</Text> : null}
        </View>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {outcome(item)}
          {item.phone && item.displayName !== formatPhone(item.phone)
            ? ` · ${formatPhone(item.phone)}`
            : ''}
        </Text>
      </View>
      <Text style={styles.time}>{when(item.at)}</Text>
      {item.customerId ? (
        <Pressable
          onPress={() =>
            router.push({ pathname: '/crm/[id]', params: { id: item.customerId as string } })
          }
          hitSlop={8}
          accessibilityLabel={`Open ${item.displayName}`}
          style={({ pressed }) => [styles.info, pressed && styles.pressed]}>
          <Ionicons name="information-circle-outline" size={22} color={colors.ocean} />
        </Pressable>
      ) : (
        <View style={styles.info} />
      )}
    </Pressable>
  );

  const header = (
    <View style={styles.headerArea}>
      <View style={styles.segments}>
        <Chip label="All" tone="ocean" selected={segment === 'all'} onPress={() => setSegment('all')} />
        <Chip
          label="Missed"
          tone="ocean"
          selected={segment === 'missed'}
          onPress={() => setSegment('missed')}
        />
      </View>
      {segment === 'missed' ? (
        <Text style={styles.hint}>
          Calls placed from the DC Solar number that did not connect. The number cannot
          receive calls yet, so there are no missed incoming calls to show.
        </Text>
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
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.screen}
      contentContainerStyle={styles.container}
      data={visible}
      keyExtractor={(item) => item.id}
      renderItem={renderCall}
      ListHeaderComponent={header}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
      }
      ListEmptyComponent={
        <View style={styles.emptyCard}>
          <Ionicons name="time-outline" size={22} color={colors.inkSoft} />
          <Text style={styles.emptyTitle}>
            {segment === 'missed' ? 'No missed calls' : 'No calls yet'}
          </Text>
          <Text style={styles.emptyBody}>
            {!voiceReady
              ? NOT_CONFIGURED_VOICE
              : segment === 'missed'
                ? 'Every call from the DC Solar number has connected so far.'
                : 'Calls placed from the DC Solar number — from the keypad, a contact, or a customer record — show up here.'}
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  center: { alignItems: 'center', justifyContent: 'center' },
  container: { padding: spacing.lg, paddingBottom: spacing.xxl },
  headerArea: { gap: spacing.sm, paddingBottom: spacing.md },
  segments: { flexDirection: 'row', gap: spacing.sm },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  note: { color: colors.ocean, fontSize: 13, fontWeight: '700' },
  noteOk: { color: colors.success },
  noteError: { color: colors.danger },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    ...shadows.card,
  },
  rowPressed: { backgroundColor: colors.skySoft },
  separator: { height: spacing.sm },
  iconWrap: {
    width: 34,
    height: 34,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconWrapMissed: { backgroundColor: colors.dangerSoft },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  rowNameMissed: { color: colors.danger },
  count: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  rowMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  time: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  info: { width: 28, alignItems: 'center', justifyContent: 'center' },
  emptyCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
