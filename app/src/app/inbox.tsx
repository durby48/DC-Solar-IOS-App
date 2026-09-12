import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import {
  FolderRail,
  FolderStrip,
  LabelPicker,
  ThreadRow,
  ThreadView,
  emptyFolderCopy,
  folderTitle,
  type ThreadChange,
} from '@/components/email';
import { EmptyState, SkeletonList } from '@/components/ui';
import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import { useConnection } from '@/lib/connection';
import {
  applyLabel,
  archiveThreads,
  fetchInboxThreads,
  fetchLabels,
  isNoMailbox,
  isOffline,
  isScopeMissing,
  markRead,
  markUnread,
  notSpam,
  starThreads,
  trashThreads,
  unarchiveThreads,
  unstarThreads,
  untrashThreads,
  type InboxThread,
  type MailFolder,
  type MailLabel,
  type ModifyResult,
} from '@/lib/gmail';
import * as haptics from '@/lib/haptics';
import { useRoleGate } from '@/lib/role';

/**
 * `/inbox` — the caller's dcsolarkc.com mailbox, Gmail-shaped, inside the app.
 *
 * WIDE (≥ 900 px): folder rail | thread list with search and multi-select |
 * reading pane. PHONE: folder strip over the list, tap opens the thread
 * screen, long-press opens an action menu, a purple pencil composes.
 *
 * GMAIL IS THE STORE. Every folder, star, label and draft here is Gmail's
 * own; the app keeps no table and no cache. What you do here you see in the
 * Gmail app a second later, and the other way round on the next refresh.
 *
 * ADMINS ONLY, AND THEN SOME. The edge function re-checks `employees.role`
 * and maps the caller's app identity to exactly one mailbox; an admin with
 * no mapping gets `no_mailbox` and a sentence saying so. The gate below is
 * the cosmetic half — it replaces an error with an explanation for the crew.
 */

const WIDE = 900;

/** Whether a row still belongs in `folder` after a change, for optimistic removal. */
function stillInFolder(item: InboxThread, folder: MailFolder): boolean {
  switch (folder) {
    case 'inbox':
      return item.inInbox && !item.inTrash;
    case 'unread':
      return item.inInbox && item.unread && !item.inTrash;
    case 'starred':
      return item.starred && !item.inTrash;
    case 'trash':
      return item.inTrash;
    case 'archive':
      return !item.inInbox && !item.inTrash;
    case 'spam':
      return item.labelIds.includes('SPAM');
    default:
      if (folder.startsWith('label:')) return item.labelIds.includes(folder.slice('label:'.length)) && !item.inTrash;
      return !item.inTrash;
  }
}

type BulkAction =
  | 'archive'
  | 'unarchive'
  | 'read'
  | 'unread'
  | 'star'
  | 'unstar'
  | 'trash'
  | 'untrash'
  | 'notSpam';

const BULK: Record<BulkAction, { run: (ids: string[]) => Promise<ModifyResult>; patch: (t: InboxThread) => InboxThread; change: ThreadChange }> = {
  archive: { run: archiveThreads, patch: (t) => ({ ...t, inInbox: false }), change: 'archived' },
  unarchive: { run: unarchiveThreads, patch: (t) => ({ ...t, inInbox: true }), change: 'unarchived' },
  read: { run: markRead, patch: (t) => ({ ...t, unread: false }), change: 'read' },
  unread: { run: markUnread, patch: (t) => ({ ...t, unread: true }), change: 'unread' },
  star: { run: starThreads, patch: (t) => ({ ...t, starred: true }), change: 'starred' },
  unstar: { run: unstarThreads, patch: (t) => ({ ...t, starred: false }), change: 'unstarred' },
  trash: { run: trashThreads, patch: (t) => ({ ...t, inTrash: true, inInbox: false }), change: 'trashed' },
  untrash: { run: untrashThreads, patch: (t) => ({ ...t, inTrash: false, inInbox: true }), change: 'untrashed' },
  notSpam: {
    run: notSpam,
    patch: (t) => ({ ...t, inInbox: true, labelIds: t.labelIds.filter((l) => l !== 'SPAM') }),
    change: 'unarchived',
  },
};

export default function EmailInboxScreen() {
  const router = useRouter();
  const { phase, role } = useRoleGate();
  const { width } = useWindowDimensions();
  const wide = width >= WIDE;
  const connection = useConnection();

  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');

  const [threads, setThreads] = useState<InboxThread[]>([]);
  const [labels, setLabels] = useState<MailLabel[]>([]);
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<InboxThread | null>(null);
  const [labelPickerFor, setLabelPickerFor] = useState<string[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshLabels = useCallback(async () => {
    const result = await fetchLabels();
    if (result.ok) setLabels(result.labels);
  }, []);

  const load = useCallback(
    async (options: { folder: MailFolder; q: string; silent?: boolean }) => {
      if (!options.silent) setLoading(true);
      const result = await fetchInboxThreads({ folder: options.folder, q: options.q });
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

  // Refetch on focus: coming back from a thread or the composer should show
  // what changed, and there is no cache to go stale in the meantime.
  useFocusEffect(
    useCallback(() => {
      if (phase !== 'ready' || !role?.isAdmin) {
        setLoading(false);
        return;
      }
      void load({ folder, q: applied, silent: true });
      void refreshLabels();
    }, [phase, role?.isAdmin, folder, applied, load, refreshLabels]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load({ folder, q: applied, silent: true }), refreshLabels()]);
    setRefreshing(false);
  }, [folder, applied, load, refreshLabels]);

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    const result = await fetchInboxThreads({ folder, q: applied, pageToken: nextPageToken });
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
  }, [nextPageToken, loadingMore, folder, applied]);

  const clearSelection = () => {
    setSelected(new Set());
    setSelectMode(false);
  };

  const pickFolder = (next: MailFolder) => {
    if (next === folder) return;
    haptics.tapLight();
    setFolder(next);
    setThreads([]);
    setActiveId(null);
    clearSelection();
    void load({ folder: next, q: applied });
  };

  const submitSearch = () => {
    const trimmed = query.trim();
    if (trimmed === applied) return;
    setApplied(trimmed);
    setThreads([]);
    clearSelection();
    void load({ folder, q: trimmed });
  };

  const clearSearch = () => {
    setQuery('');
    if (applied) {
      setApplied('');
      setThreads([]);
      void load({ folder, q: '' });
    }
  };

  const openThread = (item: InboxThread) => {
    haptics.tapLight();
    if (item.isDraft && item.draftId) {
      router.push({ pathname: '/inbox/compose', params: { draftId: item.draftId } });
      return;
    }
    if (wide) {
      setActiveId(item.id);
      // The reading pane marks it read on open; mirror that in the row now.
      setThreads((prev) => prev.map((t) => (t.id === item.id ? { ...t, unread: false } : t)));
      return;
    }
    router.push({ pathname: '/inbox/[threadId]', params: { threadId: item.id } });
  };

  const compose = () => {
    haptics.tapMedium();
    router.push('/inbox/compose');
  };

  /** Apply one bulk action to `ids`: optimistic patch, drop rows that left the folder, tell Gmail. */
  const bulk = async (action: BulkAction, ids: string[]) => {
    if (ids.length === 0 || bulkBusy) return;
    const spec = BULK[action];
    setBulkBusy(true);
    setNotice(null);
    haptics.tapMedium();
    const result = await spec.run(ids);
    setBulkBusy(false);
    if (!result.ok) {
      setNotice(result.message);
      haptics.error();
      return;
    }
    const set = new Set(ids);
    setThreads((prev) => prev.map((t) => (set.has(t.id) ? spec.patch(t) : t)).filter((t) => stillInFolder(t, folder)));
    if (activeId && set.has(activeId) && (action === 'archive' || action === 'trash' || action === 'unread')) setActiveId(null);
    clearSelection();
    if (result.failed.length) setNotice(`${result.failed.length} of ${ids.length} could not be changed.`);
    void refreshLabels();
  };

  const moveToLabel = async (ids: string[], label: MailLabel, archive: boolean) => {
    setLabelPickerFor(null);
    if (ids.length === 0) return;
    setBulkBusy(true);
    setNotice(null);
    const result = await applyLabel(ids, label.id, archive);
    setBulkBusy(false);
    if (!result.ok) {
      setNotice(result.message);
      return;
    }
    const set = new Set(ids);
    setThreads((prev) =>
      prev
        .map((t) =>
          set.has(t.id)
            ? { ...t, inInbox: archive ? false : t.inInbox, labelIds: [...new Set([...t.labelIds, label.id])] }
            : t,
        )
        .filter((t) => stillInFolder(t, folder)),
    );
    if (archive && activeId && set.has(activeId)) setActiveId(null);
    clearSelection();
    haptics.success();
    setNotice(`Moved to ${label.name}`);
    void refreshLabels();
  };

  /** The reading pane / thread screen changed a thread: keep the list honest. */
  const onThreadChanged = useCallback(
    (change: ThreadChange, id: string) => {
      setThreads((prev) => {
        const patch = (t: InboxThread): InboxThread => {
          switch (change) {
            case 'read':
              return { ...t, unread: false };
            case 'unread':
              return { ...t, unread: true };
            case 'archived':
              return { ...t, inInbox: false };
            case 'unarchived':
              return { ...t, inInbox: true };
            case 'trashed':
              return { ...t, inTrash: true, inInbox: false };
            case 'untrashed':
              return { ...t, inTrash: false, inInbox: true };
            case 'starred':
              return { ...t, starred: true };
            case 'unstarred':
              return { ...t, starred: false };
            case 'labeled':
              return t;
          }
        };
        return prev.map((t) => (t.id === id ? patch(t) : t)).filter((t) => stillInFolder(t, folder));
      });
      if (change === 'labeled') void load({ folder, q: applied, silent: true });
      void refreshLabels();
    },
    [folder, applied, load, refreshLabels],
  );

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === threads.length) clearSelection();
    else setSelected(new Set(threads.map((t) => t.id)));
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
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>,
    );
  }

  if (!role || !role.isAdmin) {
    return screen(
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name={role ? 'lock-closed' : 'mail'} size={26} color={hubColors.crm.fg} />
          </View>
          <Text style={styles.cardTitle}>{role ? 'Admins only' : 'Sign in to read email'}</Text>
          <Text style={styles.cardBody}>
            Email carries quotes, invoices and customer addresses, so it is limited to signed-in owners and
            operators.
          </Text>
        </View>
      </View>,
    );
  }

  // ---- pieces ---------------------------------------------------------------

  const searchBox = (
    <View style={styles.searchWrap}>
      <Ionicons name="search" size={16} color={colors.textMuted} />
      <TextInput
        value={query}
        onChangeText={setQuery}
        onSubmitEditing={submitSearch}
        returnKeyType="search"
        placeholder="Search mail"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.searchInput}
      />
      {query ? (
        <Pressable onPress={clearSearch} hitSlop={8} accessibilityLabel="Clear search">
          <Ionicons name="close-circle" size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );

  const selectedIds = [...selected];
  const selectedRows = threads.filter((t) => selected.has(t.id));
  const anyInInbox = selectedRows.some((t) => t.inInbox);
  const anyUnread = selectedRows.some((t) => t.unread);
  const anyUnstarred = selectedRows.some((t) => !t.starred);

  const bulkBar =
    selected.size > 0 ? (
      <View style={styles.bulkBar}>
        <Pressable onPress={selectAll} hitSlop={8} style={styles.bulkCount} accessibilityRole="button">
          <Ionicons
            name={selected.size === threads.length ? 'checkbox' : 'remove-circle-outline'}
            size={18}
            color={hubColors.crm.fg}
          />
          <Text style={styles.bulkCountText}>{selected.size}</Text>
        </Pressable>
        {bulkBusy ? <ActivityIndicator size="small" color={hubColors.crm.fg} /> : null}
        {folder === 'trash' ? (
          <BulkButton icon="arrow-undo" label="Restore" onPress={() => void bulk('untrash', selectedIds)} />
        ) : folder === 'spam' ? (
          <BulkButton icon="shield-checkmark-outline" label="Not spam" onPress={() => void bulk('notSpam', selectedIds)} />
        ) : anyInInbox ? (
          <BulkButton icon="archive-outline" label="Archive" onPress={() => void bulk('archive', selectedIds)} />
        ) : (
          <BulkButton icon="mail-open-outline" label="To Inbox" onPress={() => void bulk('unarchive', selectedIds)} />
        )}
        <BulkButton
          icon={anyUnread ? 'mail-open-outline' : 'mail-unread-outline'}
          label={anyUnread ? 'Read' : 'Unread'}
          onPress={() => void bulk(anyUnread ? 'read' : 'unread', selectedIds)}
        />
        <BulkButton
          icon={anyUnstarred ? 'star' : 'star-outline'}
          label={anyUnstarred ? 'Star' : 'Unstar'}
          onPress={() => void bulk(anyUnstarred ? 'star' : 'unstar', selectedIds)}
        />
        <BulkButton icon="pricetag-outline" label="Label" onPress={() => setLabelPickerFor(selectedIds)} />
        {folder === 'trash' ? null : (
          <BulkButton icon="trash-outline" label="Trash" tint={colors.danger} onPress={() => void bulk('trash', selectedIds)} />
        )}
        <Pressable onPress={clearSelection} hitSlop={8} accessibilityLabel="Clear selection" style={styles.bulkClear}>
          <Ionicons name="close" size={18} color={colors.inkSoft} />
        </Pressable>
      </View>
    ) : null;

  const renderThread = ({ item }: { item: InboxThread }) => (
    <ThreadRow
      item={item}
      folder={folder}
      selected={selected.has(item.id)}
      selectable={wide || selectMode}
      active={wide && activeId === item.id}
      onPress={() => (selectMode ? toggleSelect(item.id) : openThread(item))}
      onLongPress={() => {
        haptics.tapMedium();
        if (wide) toggleSelect(item.id);
        else setMenuFor(item);
      }}
      onToggleSelect={() => toggleSelect(item.id)}
      onToggleStar={() => void bulk(item.starred ? 'unstar' : 'star', [item.id])}
    />
  );

  const footer = nextPageToken ? (
    <Pressable
      onPress={() => void loadMore()}
      disabled={loadingMore}
      style={({ pressed }) => [styles.loadMore, pressed && !loadingMore && styles.pressed]}>
      {loadingMore ? (
        <ActivityIndicator color={hubColors.crm.fg} size="small" />
      ) : (
        <Text style={styles.loadMoreText}>Load more</Text>
      )}
    </Pressable>
  ) : threads.length > 0 ? (
    <Text style={styles.endNote}>That is everything in {folderTitle(folder, labels)}.</Text>
  ) : null;

  const emptyState = () => {
    if (loading) return <SkeletonList count={8} height={64} gap={1} radius={0} />;
    if (error) {
      if (isNoMailbox(error)) {
        return (
          <EmptyState
            icon="lock-closed-outline"
            title="No mailbox is linked to your account"
            body="Only accounts mapped in the gmail-inbox function (Devon and Isaiah today) have one. docs/GMAIL_INBOX_SETUP.md says how to add another."
          />
        );
      }
      if (isScopeMissing(error)) {
        return (
          <EmptyState
            icon="key-outline"
            title="Email isn't fully switched on"
            body={error}
            action={{ label: 'Try again', onPress: () => void load({ folder, q: applied }) }}
          />
        );
      }
      if (isOffline(error) || connection === 'offline') {
        return (
          <EmptyState
            icon="cloud-offline"
            title="You're offline"
            body="Mail lives in Gmail and needs a connection. Nothing is cached on this device."
            action={{ label: 'Try again', onPress: () => void load({ folder, q: applied }) }}
          />
        );
      }
      return (
        <EmptyState
          icon="cloud-offline"
          title="Mail is unavailable"
          body={error}
          action={{ label: 'Try again', onPress: () => void load({ folder, q: applied }) }}
        />
      );
    }
    if (applied) {
      return (
        <EmptyState
          icon="search"
          title="No matches"
          body={`Nothing in ${folderTitle(folder, labels)} matches “${applied}”.`}
          action={{ label: 'Clear search', onPress: clearSearch }}
        />
      );
    }
    const copy = emptyFolderCopy(folder);
    return <EmptyState icon={copy.icon} title={copy.title} body={copy.body} />;
  };

  const list = (
    <FlatList
      data={loading ? [] : threads}
      keyExtractor={(item) => item.id}
      renderItem={renderThread}
      ListHeaderComponent={
        <>
          {applied ? (
            <Text style={styles.searchNote}>
              Results for “{applied}” in {folderTitle(folder, labels)}. Gmail operators like <Text style={styles.mono}>from:</Text>{' '}
              and <Text style={styles.mono}>has:attachment</Text> work.
            </Text>
          ) : null}
          {notice ? (
            <Pressable onPress={() => setNotice(null)} style={styles.notice}>
              <Text style={styles.noticeText}>{notice}</Text>
            </Pressable>
          ) : null}
        </>
      }
      ListFooterComponent={footer}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
          tintColor={hubColors.crm.fg}
          colors={[hubColors.crm.fg]}
          progressBackgroundColor={colors.surface}
        />
      }
      ListEmptyComponent={emptyState()}
    />
  );

  const labelPicker = labelPickerFor ? (
    <LabelPicker
      visible
      labels={labels}
      inInbox={threads.some((t) => labelPickerFor.includes(t.id) && t.inInbox)}
      count={labelPickerFor.length}
      onClose={() => setLabelPickerFor(null)}
      onLabelCreated={() => void refreshLabels()}
      onPick={(label, archive) => void moveToLabel(labelPickerFor, label, archive)}
    />
  ) : null;

  // ---- wide: rail | list | reading pane --------------------------------------

  if (wide) {
    return screen(
      <View style={styles.wide}>
        <FolderRail active={folder} labels={labels} onPick={pickFolder} onCompose={compose} mailbox={mailbox} />
        <View style={[styles.listColumn, activeId && styles.listColumnNarrow]}>
          <View style={styles.listHead}>
            <Text style={styles.folderTitle}>{folderTitle(folder, labels)}</Text>
            {searchBox}
          </View>
          {bulkBar}
          {list}
        </View>
        <View style={styles.readingPane}>
          {activeId ? (
            <ThreadView
              key={activeId}
              threadId={activeId}
              labels={labels}
              embedded
              onClose={() => setActiveId(null)}
              onChanged={onThreadChanged}
              onLabelCreated={() => void refreshLabels()}
            />
          ) : (
            <View style={styles.paneEmpty}>
              <Ionicons name="mail-open-outline" size={34} color={colors.borderStrong} />
              <Text style={styles.paneEmptyText}>Select a conversation to read it here.</Text>
            </View>
          )}
        </View>
        {labelPicker}
      </View>,
    );
  }

  // ---- phone: strip over list, FAB, long-press menu ---------------------------

  const menu = menuFor;
  return screen(
    <View style={styles.screen}>
      <View style={styles.phoneHead}>
        {searchBox}
        <FolderStrip active={folder} labels={labels} onPick={pickFolder} />
        {mailbox ? (
          <Text style={styles.mailboxText} numberOfLines={1}>
            {mailbox}
          </Text>
        ) : null}
      </View>
      {bulkBar}
      {list}

      <Pressable
        onPress={compose}
        accessibilityRole="button"
        accessibilityLabel="Compose"
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}>
        <Ionicons name="pencil" size={24} color={colors.textInverse} />
      </Pressable>

      {menu ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
          <Pressable style={styles.scrim} onPress={() => setMenuFor(null)}>
            <Pressable style={styles.menu} onPress={() => undefined}>
              <Text style={styles.menuTitle} numberOfLines={2}>
                {menu.subject}
              </Text>
              <Text style={styles.menuMeta} numberOfLines={1}>
                {menu.fromName}
              </Text>
              {folder === 'trash' ? (
                <MenuItem icon="arrow-undo" label="Restore to Inbox" onPress={() => { setMenuFor(null); void bulk('untrash', [menu.id]); }} />
              ) : folder === 'spam' ? (
                <MenuItem icon="shield-checkmark-outline" label="Not spam" onPress={() => { setMenuFor(null); void bulk('notSpam', [menu.id]); }} />
              ) : menu.inInbox ? (
                <MenuItem icon="archive-outline" label="Archive" onPress={() => { setMenuFor(null); void bulk('archive', [menu.id]); }} />
              ) : (
                <MenuItem icon="mail-open-outline" label="Move to Inbox" onPress={() => { setMenuFor(null); void bulk('unarchive', [menu.id]); }} />
              )}
              <MenuItem
                icon={menu.starred ? 'star-outline' : 'star'}
                label={menu.starred ? 'Unstar' : 'Star'}
                onPress={() => { setMenuFor(null); void bulk(menu.starred ? 'unstar' : 'star', [menu.id]); }}
              />
              <MenuItem
                icon={menu.unread ? 'mail-open-outline' : 'mail-unread-outline'}
                label={menu.unread ? 'Mark read' : 'Mark unread'}
                onPress={() => { setMenuFor(null); void bulk(menu.unread ? 'read' : 'unread', [menu.id]); }}
              />
              <MenuItem icon="pricetag-outline" label="Move to label" onPress={() => { setMenuFor(null); setLabelPickerFor([menu.id]); }} />
              {folder === 'trash' ? null : (
                <MenuItem icon="trash-outline" label="Trash" tint={colors.danger} onPress={() => { setMenuFor(null); void bulk('trash', [menu.id]); }} />
              )}
              <MenuItem
                icon="checkbox-outline"
                label="Select"
                onPress={() => {
                  setMenuFor(null);
                  setSelectMode(true);
                  setSelected(new Set([menu.id]));
                }}
              />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
      {labelPicker}
    </View>,
  );
}

function BulkButton({
  icon,
  label,
  onPress,
  tint,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tint?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.bulkButton, pressed && styles.pressed]}>
      <Ionicons name={icon} size={16} color={tint ?? hubColors.crm.fg} />
      <Text style={[styles.bulkButtonText, tint ? { color: tint } : null]}>{label}</Text>
    </Pressable>
  );
}

function MenuItem({
  icon,
  label,
  onPress,
  tint,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tint?: string;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.tapLight();
        onPress();
      }}
      accessibilityRole="button"
      style={({ pressed }) => [styles.menuItem, pressed && styles.pressed]}>
      <Ionicons name={icon} size={18} color={tint ?? colors.inkSoft} />
      <Text style={[styles.menuItemText, tint ? { color: tint } : null]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: spacing.lg },
  list: { paddingBottom: spacing.xxl },

  card: {
    backgroundColor: colors.surface,
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
    backgroundColor: hubColors.crm.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  cardBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  // wide
  wide: { flex: 1, flexDirection: 'row', backgroundColor: colors.surface },
  listColumn: { flex: 1, minWidth: 320, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: colors.line },
  listColumnNarrow: { flex: 0, width: 400 },
  listHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  folderTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  readingPane: { flex: 1.4, minWidth: 360, backgroundColor: colors.surfaceAlt },
  paneEmpty: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  paneEmptyText: { color: colors.textMuted, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  // phone
  phoneHead: {
    backgroundColor: colors.surface,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    gap: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  mailboxText: { color: colors.textMuted, fontSize: 11, fontWeight: '600', paddingHorizontal: spacing.md },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: hubColors.crm.fg,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.raised,
  },
  fabPressed: { backgroundColor: hubColors.crm.deep },

  searchWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.canvas,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginHorizontal: spacing.md,
    minWidth: 160,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '600', padding: 0 },
  searchNote: { color: colors.textMuted, fontSize: 12, fontWeight: '600', padding: spacing.sm, paddingHorizontal: spacing.md },
  mono: { color: hubColors.crm.fg, fontWeight: '800' },
  notice: { backgroundColor: hubColors.crm.bg, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  noticeText: { color: hubColors.crm.deep, fontSize: 13, fontWeight: '700' },

  bulkBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexWrap: 'wrap',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: hubColors.crm.bg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  bulkCount: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.xs },
  bulkCountText: { color: hubColors.crm.deep, fontSize: 13, fontWeight: '800' },
  bulkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
  },
  bulkButtonText: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '800' },
  bulkClear: { marginLeft: 'auto', padding: spacing.xs },

  loadMore: {
    alignSelf: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  loadMoreText: { color: hubColors.crm.fg, fontSize: 13, fontWeight: '800' },
  endNote: {
    textAlign: 'center',
    marginTop: spacing.md,
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },

  scrim: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  menu: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    padding: spacing.md,
    paddingBottom: spacing.xl,
    gap: 2,
  },
  menuTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  menuMeta: { color: colors.textMuted, fontSize: 12, fontWeight: '600', marginBottom: spacing.sm },
  menuItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2, paddingVertical: spacing.sm + 4 },
  menuItemText: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.7 },
});
