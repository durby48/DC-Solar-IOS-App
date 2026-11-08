import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';

import { AppText, EmptyState } from '@/components/ui';
import { colors, spacing } from '@/constants/theme';
import { fetchAlerts, markAlertsRead, refreshUnreadAlerts, type AlertRow } from '@/lib/alerts';
import { openNotificationTarget } from '@/lib/notificationRouter';
import type { NotificationTarget } from '@/lib/notificationTargets';

/**
 * `/alerts` (2026-11-08) — every push this person was sent, newest first:
 * texts, missed calls, leads and prospects, tasks, appointments, the job
 * schedule, emails from customers, payments, storms. Tapping one marks it
 * read and opens the same screen the push opens. Kept 90 days.
 */

type IconName = React.ComponentProps<typeof Ionicons>['name'];

function iconFor(target: NotificationTarget | null): IconName {
  switch (target?.type) {
    case 'sms_thread':
      return 'chatbubble-ellipses-outline';
    case 'call':
      return 'call-outline';
    case 'lead':
    case 'prospects':
      return 'person-add-outline';
    case 'customer':
      return 'person-outline';
    case 'job':
      return 'construct-outline';
    case 'schedule':
    case 'appointment':
      return 'calendar-outline';
    case 'task':
      return 'checkbox-outline';
    case 'storm':
      return 'thunderstorm-outline';
    case 'email_thread':
    case 'inbox':
      return 'mail-outline';
    case 'financials':
      return 'cash-outline';
    default:
      return 'notifications-outline';
  }
}

function ago(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const min = Math.round((Date.now() - then) / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function AlertsScreen() {
  const router = useRouter();
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const result = await fetchAlerts();
    if (result.status === 'ok') {
      setAlerts(result.alerts);
      setError(null);
    } else {
      setError(result.message);
      setAlerts((prev) => prev ?? []);
    }
    void refreshUnreadAlerts();
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const open = async (alert: AlertRow) => {
    if (!alert.readAt) {
      setAlerts((list) => list?.map((a) => (a.id === alert.id ? { ...a, readAt: new Date().toISOString() } : a)) ?? null);
      void markAlertsRead([alert.id]);
    }
    if (alert.target) await openNotificationTarget(alert.target);
  };

  const markAll = async () => {
    setAlerts((list) => list?.map((a) => (a.readAt ? a : { ...a, readAt: new Date().toISOString() })) ?? null);
    await markAlertsRead(null);
  };

  const unread = alerts?.filter((a) => !a.readAt).length ?? 0;

  return (
    <View style={styles.screen}>
      <Stack.Screen
        options={{
          title: 'Alerts',
          headerRight: () => (
            <View style={styles.headerRight}>
              {unread > 0 ? (
                <Pressable onPress={() => void markAll()} hitSlop={8}>
                  <AppText variant="bodyStrong" color={colors.ocean}>
                    Mark all read
                  </AppText>
                </Pressable>
              ) : null}
              <Pressable
                onPress={() => router.push('/notifications' as never)}
                hitSlop={8}
                accessibilityLabel="Notification settings">
                <Ionicons name="settings-outline" size={22} color={colors.ocean} />
              </Pressable>
            </View>
          ),
        }}
      />
      {alerts === null ? (
        <ActivityIndicator color={colors.ocean} style={styles.loading} />
      ) : (
        <FlatList
          data={alerts}
          keyExtractor={(a) => a.id}
          contentContainerStyle={alerts.length === 0 ? styles.emptyWrap : styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.ocean}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ListHeaderComponent={
            error ? (
              <AppText variant="caption" color={colors.danger} style={styles.error}>
                {error}
              </AppText>
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="notifications-outline"
              title="No alerts yet"
              body="Texts, missed calls, leads, tasks, appointments and schedule changes you're notified about show up here."
            />
          }
          renderItem={({ item }) => (
            <Pressable
              onPress={() => void open(item)}
              style={({ pressed }) => [styles.row, !item.readAt && styles.rowUnread, pressed && { opacity: 0.7 }]}>
              <View style={styles.iconWrap}>
                <Ionicons name={iconFor(item.target)} size={20} color={item.readAt ? colors.textMuted : colors.ocean} />
              </View>
              <View style={styles.text}>
                <AppText variant="bodyStrong" numberOfLines={1} color={item.readAt ? colors.textSecondary : colors.textPrimary}>
                  {item.title}
                </AppText>
                {item.body ? (
                  <AppText variant="caption" numberOfLines={2} color={colors.textSecondary}>
                    {item.body}
                  </AppText>
                ) : null}
              </View>
              <View style={styles.meta}>
                <AppText variant="caption" color={colors.textMuted}>
                  {ago(item.createdAt)}
                </AppText>
                {!item.readAt ? <View style={styles.dot} /> : null}
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

// A render error replaces only this screen; the header stays (2026-11-08).
export { ScreenErrorBoundary as ErrorBoundary } from '@/components/ScreenErrorBoundary';

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  loading: { marginTop: spacing.xl },
  list: { paddingVertical: spacing.sm },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', padding: spacing.lg },
  error: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowUnread: { backgroundColor: colors.surface },
  iconWrap: { width: 28, alignItems: 'center', paddingTop: 2 },
  text: { flex: 1, gap: 2 },
  meta: { alignItems: 'flex-end', gap: 6, paddingTop: 2 },
  dot: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.ocean },
});
