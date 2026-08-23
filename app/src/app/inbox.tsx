import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { EmptyState, SkeletonList } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  fetchInboxThreads,
  gmailThreadUrl,
  openInGmail,
  type InboxLabel,
  type InboxThread,
} from '@/lib/gmail';
import * as haptics from '@/lib/haptics';
import { useRoleGate } from '@/lib/role';

/**
 * `/inbox` — Devon's dcsolarkc.com mail, read-only, inside the app.
 *
 * WHY IT IS READ-ONLY AND WHY THAT IS THE FEATURE. The Google service account
 * behind this holds `gmail.readonly` over the whole Workspace domain, so it
 * physically cannot send, archive, label or delete. Everything that would
 * change a mailbox — reply, forward, star — is a deep link that opens Gmail,
 * where those actions already live and already have an audit trail. The app's
 * job is "I am on a roof and I need to see whether the supplier answered",
 * not to be a second mail client.
 *
 * ADMINS ONLY, AND THEN SOME. The edge function re-checks `employees.role`
 * and then maps the caller's app identity to exactly one mailbox; an admin
 * with no mapping gets `no_mailbox` and a sentence saying so. The gate below
 * is the cosmetic half — it replaces an error with an explanation for the
 * crew, who have no business reading the owner's mail either way.
 *
 * NOTHING IS CACHED. No table, no AsyncStorage, no offline copy: the app never
 * stores a subject line, let alone a body. Close the screen and it is gone.
 */

/** "now", "12m", "3h", "2d", then a date. Same ladder as the Comms inbox. */
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

const LABELS: { key: InboxLabel; label: string }[] = [
  { key: 'INBOX', label: 'Inbox' },
  { key: 'UNREAD', label: 'Unread' },
  { key: 'STARRED', label: 'Starred' },
];

export default function EmailInboxScreen() {
  const router = useRouter();
  const { phase, role } = useRoleGate();

  const [label, setLabel] = useState<InboxLabel>('INBOX');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');

  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (options: { label: InboxLabel; q: string; silent?: boolean }) => {
      if (!options.silent) setLoading(true);
      const result = await fetchInboxThreads({ label: options.label, q: options.q });
      setLoading(false);
      if (!result.ok) {
        setError(result.message);
        setThreads([]);
        setNextPageToken(null);
        return;
      }
      setError(null);
      setMailbox(result.mailbox);
      setThreads(result.threads);
      setNextPageToken(result.nextPageToken);
    },
    [],
  );

  // Refetch on focus: coming back from a thread should show what has arrived
  // since, and there is no cache to go stale in the meantime.
  useFocusEffect(
    useCallback(() => {
      if (phase !== 'ready' || !role?.isAdmin) {
        setLoading(false);
        return;
      }
      void load({ label, q: applied, silent: true });
    }, [phase, role?.isAdmin, label, applied, load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load({ label, q: applied, silent: true });
    setRefreshing(false);
  }, [label, applied, load]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    const result = await fetchInboxThreads({ label, q: applied, pageToken: nextPageToken });
    setLoadingMore(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    // Gmail can repeat a thread across pages when new mail arrives mid-scroll.
    setThreads((previous) => {
      const seen = new Set(previous.map((t) => t.id));
      return [...previous, ...result.threads.filter((t) => !seen.has(t.id))];
    });
    setNextPageToken(result.nextPageToken);
  }, [nextPageToken, loadingMore, label, applied]);

  const pickLabel = (next: InboxLabel) => {
    if (next === label) return;
    haptics.tapLight();
    setLabel(next);
    setThreads([]);
    void load({ label: next, q: applied });
  };

  const submitSearch = () => {
    const trimmed = query.trim();
    if (trimmed === applied) return;
    setApplied(trimmed);
    setThreads([]);
    void load({ label, q: trimmed });
  };

  const clearSearch = () => {
    setQuery('');
    if (applied) {
      setApplied('');
      setThreads([]);
      void load({ label, q: '' });
    }
  };

  const screen = (body: React.ReactNode) => (
    <>
      <Stack.Screen options={{ title: 'Email' }} />
      {body}
    </>
  );

  if (phase === 'loading') {
    return screen(
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accentPrimary} />
      </View>,
    );
  }

  if (!role) {
    return screen(
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="mail" size={26} color={colors.olive} />
          </View>
          <Text style={styles.cardTitle}>Sign in to read email</Text>
          <Text style={styles.cardBody}>
            The DC Solar mailbox is only available to signed-in owners and operators.
          </Text>
        </View>
      </View>,
    );
  }

  if (!role.isAdmin) {
    return screen(
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={26} color={colors.olive} />
          </View>
          <Text style={styles.cardTitle}>Admins only</Text>
          <Text style={styles.cardBody}>
            Email carries quotes, invoices and customer addresses, so it is limited to owners
            and operators.
          </Text>
        </View>
      </View>,
    );
  }

  const header = (
    <View style={styles.headerArea}>
      <View style={styles.mailboxRow}>
        <Ionicons name="mail-open-outline" size={14} color={colors.inkSoft} />
        <Text style={styles.mailboxText} numberOfLines={1}>
          {mailbox ?? 'Loading mailbox…'} · read-only
        </Text>
      </View>

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.inkSoft} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={submitSearch}
          returnKeyType="search"
          placeholder="Search mail (Gmail search works here)"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {query ? (
          <Pressable onPress={clearSearch} hitSlop={8} accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={16} color={colors.inkSoft} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.chipRow}>
        {LABELS.map((option) => {
          const active = option.key === label;
          return (
            <Pressable
              key={option.key}
              onPress={() => pickLabel(option.key)}
              style={[styles.chip, active && styles.chipActive]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {applied ? (
        <Text style={styles.searchNote}>
          Showing results for “{applied}”. Gmail operators like{' '}
          <Text style={styles.mono}>from:</Text> and <Text style={styles.mono}>has:attachment</Text>{' '}
          work.
        </Text>
      ) : null}

      {error ? (
        <View style={styles.errorCard}>
          <Ionicons name="alert-circle" size={16} color={colors.danger} />
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}
    </View>
  );

  // The "Open in Gmail" button is a SIBLING of the row press target, not a
  // child of it. Nested Pressables both fire on react-native-web, so a tap on
  // the icon would open Gmail AND push the thread screen.
  const renderThread = ({ item }: { item: InboxThread }) => (
    <View style={styles.row}>
      <Pressable
        onPress={() => {
          haptics.tapLight();
          router.push({ pathname: '/inbox/[threadId]', params: { threadId: item.id } });
        }}
        style={({ pressed }) => [styles.rowMain, pressed && styles.rowPressed]}>
        <View style={[styles.rowDot, item.unread && styles.rowDotUnread]} />
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <Text style={[styles.rowFrom, item.unread && styles.rowFromUnread]} numberOfLines={1}>
              {item.fromName || item.from || 'Unknown sender'}
            </Text>
            {item.messageCount > 1 ? (
              <Text style={styles.rowCount}>{item.messageCount}</Text>
            ) : null}
            {item.starred ? <Ionicons name="star" size={12} color={colors.amber} /> : null}
            {item.hasAttachments ? (
              <Ionicons name="attach" size={13} color={colors.inkSoft} />
            ) : null}
            <Text style={styles.rowTime}>{relativeTime(item.date)}</Text>
          </View>
          <Text
            style={[styles.rowSubject, item.unread && styles.rowSubjectUnread]}
            numberOfLines={1}>
            {item.subject}
          </Text>
          <Text style={styles.rowSnippet} numberOfLines={2}>
            {item.snippet || '—'}
          </Text>
        </View>
      </Pressable>
      <Pressable
        onPress={() => void openInGmail(gmailThreadUrl(item.id))}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel="Open in Gmail"
        style={({ pressed }) => [styles.rowGmail, pressed && styles.pressed]}>
        <Ionicons name="open-outline" size={16} color={colors.ocean} />
      </Pressable>
    </View>
  );

  const footer = nextPageToken ? (
    <Pressable
      onPress={() => void loadMore()}
      disabled={loadingMore}
      style={({ pressed }) => [styles.loadMore, pressed && !loadingMore && styles.pressed]}>
      {loadingMore ? (
        <ActivityIndicator color={colors.accentPrimary} size="small" />
      ) : (
        <Text style={styles.loadMoreText}>Load more</Text>
      )}
    </Pressable>
  ) : threads.length > 0 ? (
    <Text style={styles.endNote}>That is everything in this view.</Text>
  ) : null;

  return screen(
    <View style={styles.screen}>
      <FlatList
        data={loading ? [] : threads}
        keyExtractor={(item) => item.id}
        renderItem={renderThread}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        contentContainerStyle={styles.list}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void onRefresh()}
            tintColor={colors.accentPrimary}
            colors={[colors.accentPrimary]}
            progressBackgroundColor={colors.surface}
          />
        }
        ListEmptyComponent={
          loading ? (
            <SkeletonList count={6} height={78} gap={spacing.sm} radius={radii.md} />
          ) : error ? (
            <EmptyState
              icon="cloud-offline"
              title="Mail is unavailable"
              body={error}
              action={{ label: 'Try again', onPress: () => void load({ label, q: applied }) }}
            />
          ) : applied ? (
            <EmptyState
              icon="search"
              title="No matches"
              body={`Nothing in this mailbox matches “${applied}”.`}
              action={{ label: 'Clear search', onPress: clearSearch }}
            />
          ) : label === 'UNREAD' ? (
            <EmptyState icon="checkmark-done" title="Nothing unread" body="Inbox zero. Enjoy it." />
          ) : label === 'STARRED' ? (
            <EmptyState
              icon="star-outline"
              title="Nothing starred"
              body="Star a message in Gmail and it shows up here."
            />
          ) : (
            <EmptyState icon="mail-outline" title="Inbox is empty" body="No mail to show." />
          )
        }
      />
    </View>,
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: spacing.lg },
  list: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },

  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    ...shadows.card,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  cardBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  headerArea: { gap: spacing.sm, paddingBottom: spacing.xs },
  mailboxRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  mailboxText: { flex: 1, color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '600', padding: 0 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  chip: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  chipActive: { backgroundColor: colors.olive, borderColor: colors.olive },
  chipText: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  chipTextActive: { color: colors.textOnDark },
  searchNote: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  mono: { color: colors.olive, fontWeight: '800' },

  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, fontWeight: '700' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingRight: spacing.md,
    ...shadows.subtle,
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
  },
  rowPressed: { backgroundColor: colors.oliveTint },
  rowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 6,
    backgroundColor: 'transparent',
  },
  rowDotUnread: { backgroundColor: colors.ocean },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowFrom: { flex: 1, color: colors.inkSoft, fontSize: 14, fontWeight: '600' },
  rowFromUnread: { color: colors.ink, fontWeight: '800' },
  rowCount: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    backgroundColor: colors.oliveSoft,
    borderRadius: radii.pill,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  rowTime: { color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  rowSubject: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  rowSubjectUnread: { fontWeight: '800' },
  rowSnippet: { color: colors.inkSoft, fontSize: 13, fontWeight: '500' },
  rowGmail: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },

  loadMore: {
    alignSelf: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  loadMoreText: { color: colors.olive, fontSize: 13, fontWeight: '800' },
  endNote: {
    textAlign: 'center',
    marginTop: spacing.sm,
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
});
