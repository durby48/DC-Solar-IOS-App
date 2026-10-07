import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchRecents, formatDuration, useCommsRealtime, type RecentCall } from '@/lib/comms';
import { fetchWorkspaceRecords, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * Recent calls (2026-10-07) — the Recents tab of the keypad window
 * (components/phone/DialerWindow, 2026-10-09) and the `/recents` screen
 * (rep Settings → Recent calls). `onLeave` runs before anything that
 * navigates (the window closes first); `reloadKey` re-reads.
 *
 * Every call to or from the rep's DC Solar number, newest first, folded like
 * the iPhone's (three missed calls from one person read "×3"). Since
 * 2026-10-07_lead_map.sql a rep reads every CALL on their own line, not only
 * calls filed on their records, so a stranger's call shows here too.
 *
 * TAP A CALL → that person in the CRM: the customer, else the lead, else the
 * rep's record with the same phone number (a booked lead's calls can be filed
 * on its hidden customer). A caller who is nobody yet opens the Keypad with
 * their number filled in — call back, or Save as prospect. The phone icon on
 * the right calls them back from the rep's number.
 */
function when(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const startOfToday = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  if (d.getTime() >= startOfToday) return time;
  if (d.getTime() >= startOfToday - 86_400_000) return `Yesterday ${time}`;
  if (d.getTime() >= startOfToday - 6 * 86_400_000) return `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function RecentCallsList({
  reloadKey = 0,
  onLeave,
  onDialUnknown,
}: {
  reloadKey?: number;
  onLeave?: () => void;
  /** A caller who is nobody yet: open the keypad with their number. */
  onDialUnknown: (phone: string) => void;
}) {
  const router = useRouter();
  const [calls, setCalls] = useState<RecentCall[] | null>(null);
  const [records, setRecords] = useState<WorkspaceRecord[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, r] = await Promise.all([fetchRecents(200), fetchWorkspaceRecords()]);
    setCalls(c);
    setRecords(r.records);
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  // A call ending updates its row several times; one reload per burst.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useCommsRealtime(
    useCallback(() => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 1500);
    }, [load]),
  );

  /** The CRM record a call belongs to, as the rep sees the CRM. */
  const recordFor = (call: RecentCall): WorkspaceRecord | null => {
    const byKey = (key: string) => records.find((r) => r.key === key) ?? null;
    return (
      (call.customerId ? byKey(`customer:${call.customerId}`) : null) ??
      (call.leadId ? byKey(`lead:${call.leadId}`) : null) ??
      (call.phone
        ? (records.find((r) => r.kind === 'lead' && r.phoneE164 === call.phone) ??
          records.find((r) => r.phoneE164 === call.phone) ??
          null)
        : null)
    );
  };

  const open = (call: RecentCall) => {
    const record = recordFor(call);
    if (record) {
      onLeave?.();
      router.navigate({ pathname: '/workspace', params: { open: record.key } } as never);
    } else if (call.phone) {
      onDialUnknown(call.phone);
    }
  };

  const callBack = (call: RecentCall) => {
    if (!call.phone) return;
    if (!inAppCallingSupported()) {
      setNotice('Calls from your DC Solar number work in the DC Solar app or at app.dcsolarkc.com.');
      return;
    }
    const record = recordFor(call);
    const params: Record<string, string> = { to: call.phone, name: record?.name ?? call.displayName };
    if (record?.kind === 'customer') params.customerId = record.id;
    onLeave?.();
    router.push({ pathname: '/call', params } as never);
  };

  const renderCall = ({ item }: { item: RecentCall }) => {
    const record = recordFor(item);
    const missedIn = item.missed && item.direction === 'in';
    const label = item.missed ? (item.direction === 'in' ? 'Missed' : 'No answer') : item.direction === 'in' ? 'Incoming' : 'Outgoing';
    return (
      <Pressable onPress={() => open(item)} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
        <Ionicons
          name={item.direction === 'in' ? 'arrow-down' : 'arrow-up'}
          size={16}
          color={missedIn ? colors.danger : colors.inkSoft}
          style={styles.dirIcon}
        />
        <View style={styles.body}>
          <Text style={[styles.name, missedIn && styles.missed]} numberOfLines={1}>
            {record?.name ?? item.displayName}
            {item.count > 1 ? ` (${item.count})` : ''}
          </Text>
          <Text style={styles.meta} numberOfLines={1}>
            {label}
            {item.durationSeconds && !item.missed ? ` · ${formatDuration(item.durationSeconds)}` : ''}
            {record ? '' : ' · not in your CRM'}
          </Text>
        </View>
        <Text style={styles.time}>{when(item.at)}</Text>
        {item.phone ? (
          <Pressable onPress={() => callBack(item)} hitSlop={8} accessibilityLabel="Call back" style={styles.callButton}>
            <Ionicons name="call" size={16} color={hubColors.crm.fg} />
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  if (calls === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      {notice ? <Text style={styles.notice}>{notice}</Text> : null}
      <FlatList
        data={calls}
        keyExtractor={(c) => c.id}
        renderItem={renderCall}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.sep} />}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
        ListEmptyComponent={<Text style={styles.empty}>No calls yet. Calls to and from your DC Solar number show up here.</Text>}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceAlt },
  list: { width: '100%', maxWidth: 640, alignSelf: 'center', padding: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
  },
  pressed: { opacity: 0.6 },
  dirIcon: { width: 18 },
  body: { flex: 1, gap: 2 },
  name: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  missed: { color: colors.danger },
  meta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  time: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  callButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: hubColors.crm.bg,
  },
  sep: { height: spacing.xs },
  empty: { color: colors.inkSoft, fontSize: 13, textAlign: 'center', marginTop: spacing.xl },
  notice: { color: colors.danger, fontSize: 13, fontWeight: '700', textAlign: 'center', padding: spacing.sm },
});
