import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_SMS,
  fetchCommsSettings,
  fetchThreads,
  formatPhone,
  useCommsRealtime,
  type CommsSettings,
  type CommsThread,
} from '@/lib/comms';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * The shared inbox — every conversation on the DC Solar business number, the
 * way a phone lists them: one row per person, newest first, tap to open the
 * conversation, a compose button bottom-right for a brand-new one.
 *
 * THERE IS EXACTLY ONE OF THESE. `/crm/inbox` renders it under its own Stack
 * header, and the Phone section's Messages tab renders it inside the nested
 * tab bar. A second thread list that drifts from the first is the actual
 * failure mode a shared inbox exists to prevent, so the body lives here and
 * the two routes are a header and an import each. Deleting this file must
 * break both.
 *
 * EVERY ROW OPENS THE SAME SCREEN — `/messages/thread`, the conversation view
 * (`components/comms/Conversation.tsx`) — whether the far end is a customer,
 * a supplier, or a number nobody has saved. The customer record's Comms
 * segment still exists for reading the thread next to jobs and money; this
 * is the texting flow.
 *
 * ADMIN ONLY, cosmetically. `messages` is admin-only on all four RLS verbs, so
 * a viewer's queries return nothing at all; the gate below just replaces an
 * empty screen with an explanation.
 */

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 90) return 'now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** The params `/messages/thread` needs to load and name this conversation. */
export function threadParams(thread: CommsThread): Record<string, string> {
  const params: Record<string, string> = { name: thread.displayName };
  if (thread.customerId) params.customerId = thread.customerId;
  else if (thread.contactId) params.contactId = thread.contactId;
  if (thread.phone) params.phone = thread.phone;
  return params;
}

export function Inbox({
  showSettingsLink = false,
}: {
  /**
   * The Phone section's tab bar has no header of its own for a settings
   * gear, so it asks for an in-body link instead. `/crm/inbox` keeps its
   * header button and passes nothing.
   */
  showSettingsLink?: boolean;
}) {
  const router = useRouter();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [authState, setAuthState] = useState<'loading' | 'out' | 'in'>('loading');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [threads, setThreads] = useState<CommsThread[]>([]);
  const [settings, setSettings] = useState<CommsSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setAuthState(data.session?.user?.email ? 'in' : 'out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setAuthState(session?.user?.email ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const load = useCallback(async () => {
    const [threadRows, settingsRow] = await Promise.all([fetchThreads(), fetchCommsSettings()]);
    setThreads(threadRows);
    setSettings(settingsRow);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (authState === 'out') {
        setLoading(false);
        return;
      }
      if (authState !== 'in') return;
      void load();
    }, [authState, load]),
  );

  // Live inbound texts. The focus refetch above stays the source of truth —
  // this only saves a pull-to-refresh while the screen is already open.
  useCommsRealtime(
    useCallback(() => {
      if (authState === 'in') void load();
    }, [authState, load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openThread = (thread: CommsThread) => {
    router.push({ pathname: '/messages/thread', params: threadParams(thread) } as never);
  };

  const renderThread = ({ item }: { item: CommsThread }) => {
    const unread = item.unread > 0;
    const supplier = Boolean(item.contactId);
    return (
      <Pressable
        onPress={() => openThread(item)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <View style={[styles.iconWrap, item.unknown && styles.iconWrapUnknown]}>
          <Ionicons
            name={
              item.unknown
                ? 'help'
                : supplier
                  ? 'storefront'
                  : item.lastMessage.channel === 'call'
                    ? 'call'
                    : 'chatbubble'
            }
            size={16}
            color={item.unknown ? colors.slateDeep : colors.ocean}
          />
        </View>
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <Text style={[styles.rowName, unread && styles.rowNameUnread]} numberOfLines={1}>
              {item.displayName}
            </Text>
            {item.optedOut ? (
              <View style={styles.stopChip}>
                <Text style={styles.stopChipText}>STOP</Text>
              </View>
            ) : null}
            <Text style={styles.rowTime}>{relativeTime(item.lastAt)}</Text>
          </View>
          <Text style={[styles.rowPreview, unread && styles.rowPreviewUnread]} numberOfLines={2}>
            {item.preview || '—'}
          </Text>
          {(item.unknown || supplier) && item.phone ? (
            <Text style={styles.rowNumber}>{formatPhone(item.phone)}</Text>
          ) : null}
        </View>
        {unread ? (
          <View style={styles.unreadPill}>
            <Text style={styles.unreadPillText}>{item.unread}</Text>
          </View>
        ) : (
          <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
        )}
      </Pressable>
    );
  };

  if (authState === 'loading' || (authState === 'in' && loading)) {
    return (
      <View style={[styles.screen, styles.centerScreen]}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  if (authState === 'out') {
    return (
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.centerCard}>
          <View style={styles.badge}>
            <Ionicons name="chatbubbles" size={26} color={colors.ocean} />
          </View>
          <Text style={styles.promptTitle}>Sign in to view messages</Text>
          <Text style={styles.promptText}>
            Customer conversations are only visible to signed-in admins.
          </Text>
        </View>
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.centerCard}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={26} color={colors.ocean} />
          </View>
          <Text style={styles.promptTitle}>Admins only</Text>
          <Text style={styles.promptText}>
            Message threads carry prices and addresses, so they are limited to owners and
            operators.
          </Text>
        </View>
      </View>
    );
  }

  const configured = settings?.smsEnabled === true && Boolean(settings?.fromNumber);

  const header = (
    <View style={styles.headerArea}>
      <View style={[styles.noticeCard, !configured && styles.noticeCardMuted]}>
        <Ionicons
          name={configured ? 'information-circle' : 'construct'}
          size={16}
          color={configured ? colors.ocean : colors.slateDeep}
        />
        <Text style={styles.noticeText}>
          {configured
            ? `Texts come from ${formatPhone(settings?.fromNumber)}`
            : NOT_CONFIGURED_SMS}
        </Text>
        {showSettingsLink ? (
          <Pressable
            onPress={() => router.push('/crm/settings')}
            hitSlop={8}
            accessibilityLabel="Messaging settings"
            style={({ pressed }) => pressed && styles.pressed}>
            <Ionicons name="settings-outline" size={18} color={colors.ocean} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );

  return (
    <View style={styles.screen}>
      <FlatList
        style={styles.screen}
        contentContainerStyle={styles.container}
        data={threads}
        keyExtractor={(item) => item.key}
        renderItem={renderThread}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
        }
        ListEmptyComponent={
          <View style={styles.centerCard}>
            <Ionicons name="chatbubbles-outline" size={22} color={colors.inkSoft} />
            <Text style={styles.promptTitle}>No messages yet</Text>
            <Text style={styles.promptText}>
              {configured
                ? 'Texts to and from the DC Solar number show up here. Tap the pencil to start one.'
                : 'Once the business number is live, every text lands here.'}
            </Text>
          </View>
        }
      />
      {/* New message. Bottom-right, like every phone's Messages app. */}
      <Pressable
        onPress={() => router.push('/messages/compose' as never)}
        accessibilityLabel="New message"
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}>
        <Ionicons name="create" size={24} color={colors.ink} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  centerScreen: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: spacing.lg },
  container: { padding: spacing.lg, gap: 0, paddingBottom: spacing.xxl * 2 },
  headerArea: { paddingBottom: spacing.md },

  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noticeCardMuted: { backgroundColor: colors.slateSoft },
  noticeText: { flex: 1, color: colors.inkSoft, fontSize: 13, fontWeight: '600' },

  centerCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  badge: {
    width: 56,
    height: 56,
    borderRadius: radii.lg,
    backgroundColor: colors.white,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  promptText: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

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
  iconWrapUnknown: { backgroundColor: colors.slateSoft },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowName: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '600' },
  rowNameUnread: { fontWeight: '800' },
  rowTime: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  rowPreview: { color: colors.inkSoft, fontSize: 13, fontWeight: '500' },
  rowPreviewUnread: { color: colors.ink, fontWeight: '700' },
  rowNumber: { color: colors.slateDeep, fontSize: 12, fontWeight: '600' },
  unreadPill: {
    minWidth: 22,
    paddingHorizontal: 6,
    height: 22,
    borderRadius: radii.pill,
    backgroundColor: colors.ocean,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadPillText: { color: colors.white, fontSize: 12, fontWeight: '800' },
  stopChip: {
    backgroundColor: colors.coralSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  stopChipText: { color: colors.coralDeep, fontSize: 10, fontWeight: '800' },

  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.sun,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.raised,
  },
  fabPressed: { opacity: 0.8 },
  pressed: { opacity: 0.6 },
});
