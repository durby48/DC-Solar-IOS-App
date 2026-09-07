import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { type RecordKind, type WorkspaceRecord } from '@/lib/crmWorkspace';

/**
 * The left column: everyone, most recent contact first, with search and a
 * Customers / Leads lens. One row per relationship — a customer or a lead —
 * showing the thing you need to decide whether to open it: current job and
 * stage (or the lead's funnel status), when you last spoke, unread texts,
 * STOP.
 *
 * Pattern: Chatwoot's conversation list (recency-ordered, unread state on the
 * row, search on top) applied to records rather than conversations, because
 * in DC Solar the durable thing is the customer, not the thread.
 *
 * A fourth lens, Tasks, swaps the record list for `tasksPane` (the bucketed
 * follow-up list) under the same search box; its chip carries the number of
 * tasks overdue or due today.
 */

export type ListMode = RecordKind | 'all' | 'tasks';

function relativeTime(iso: string | null): string {
  if (!iso) return '';
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

export function RecordList({
  records,
  total,
  selectedKey,
  onSelect,
  search,
  onSearch,
  kind,
  onKind,
  onNewLead,
  taskBadge = 0,
  tasksPane,
}: {
  records: WorkspaceRecord[];
  total: { customers: number; leads: number };
  selectedKey: string | null;
  onSelect: (record: WorkspaceRecord) => void;
  search: string;
  onSearch: (next: string) => void;
  kind: ListMode;
  onKind: (next: ListMode) => void;
  onNewLead?: () => void;
  /** Open tasks overdue or due today — shown on the Tasks chip. */
  taskBadge?: number;
  /** Rendered in place of the record list while `kind === 'tasks'`. */
  tasksPane?: ReactNode;
}) {
  const renderRow = ({ item }: { item: WorkspaceRecord }) => {
    const selected = item.key === selectedKey;
    const unread = item.unread > 0;
    return (
      <Pressable
        onPress={() => onSelect(item)}
        style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}>
        <CustomerAvatar customer={{ id: item.id, name: item.name }} size={36} url={null} />
        <View style={styles.rowBody}>
          <View style={styles.rowTop}>
            <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={styles.time}>{relativeTime(item.lastActivityAt)}</Text>
          </View>
          <View style={styles.rowBottom}>
            {item.kind === 'lead' ? (
              <View style={styles.leadPill}>
                <Text style={styles.leadPillText}>LEAD</Text>
              </View>
            ) : null}
            <Text style={styles.subtitle} numberOfLines={1}>
              {item.subtitle ?? item.address ?? (item.phoneE164 ? formatPhone(item.phoneE164) : '')}
            </Text>
            {item.optedOut ? (
              <View style={styles.stopPill}>
                <Text style={styles.stopPillText}>STOP</Text>
              </View>
            ) : null}
            {unread ? (
              <View style={styles.unreadPill}>
                <Text style={styles.unreadPillText}>{item.unread}</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  };

  return (
    <View style={styles.column}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={15} color={colors.inkSoft} />
        <TextInput
          value={search}
          onChangeText={onSearch}
          placeholder={kind === 'tasks' ? 'Search tasks' : 'Search name, phone, address, job #'}
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {search ? (
          <Pressable onPress={() => onSearch('')} hitSlop={8} accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={15} color={colors.inkSoft} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.filters}>
        <Chip label={`All ${total.customers + total.leads}`} tone="ocean" selected={kind === 'all'} onPress={() => onKind('all')} />
        <Chip label={`Customers ${total.customers}`} tone="ocean" selected={kind === 'customer'} onPress={() => onKind('customer')} />
        <Chip label={`Leads ${total.leads}`} tone="ocean" selected={kind === 'lead'} onPress={() => onKind('lead')} />
        {tasksPane ? (
          <Chip
            label={taskBadge ? `Tasks ${taskBadge}` : 'Tasks'}
            tone={taskBadge && kind !== 'tasks' ? 'sun' : 'ocean'}
            selected={kind === 'tasks'}
            onPress={() => onKind('tasks')}
          />
        ) : null}
        {onNewLead && kind !== 'tasks' ? (
          <Pressable onPress={onNewLead} style={({ pressed }) => [styles.newLead, pressed && styles.pressed]}>
            <Ionicons name="add" size={14} color={colors.ocean} />
            <Text style={styles.newLeadText}>Lead</Text>
          </Pressable>
        ) : null}
      </View>
      {kind === 'tasks' && tasksPane ? (
        tasksPane
      ) : (
        <FlatList
          data={records}
          keyExtractor={(item) => item.key}
          renderItem={renderRow}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            <Text style={styles.empty}>
              {search ? 'Nobody matches that search.' : 'No records yet.'}
            </Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, backgroundColor: colors.canvas },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    margin: spacing.sm,
    marginBottom: spacing.xs,
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '500', paddingVertical: 2 },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  newLead: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.line,
  },
  newLeadText: { color: colors.ocean, fontSize: 12, fontWeight: '800' },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowSelected: { backgroundColor: colors.white },
  rowPressed: { backgroundColor: colors.skySoft },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  name: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600' },
  nameUnread: { fontWeight: '800' },
  time: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  subtitle: { flex: 1, color: colors.inkSoft, fontSize: 12, fontWeight: '500' },
  leadPill: { backgroundColor: colors.amberSoft, borderRadius: radii.pill, paddingHorizontal: 6, paddingVertical: 1 },
  leadPillText: { color: colors.amberDeep, fontSize: 9, fontWeight: '800', letterSpacing: 0.5 },
  stopPill: { backgroundColor: colors.coralSoft, borderRadius: radii.pill, paddingHorizontal: 6, paddingVertical: 1 },
  stopPillText: { color: colors.coralDeep, fontSize: 9, fontWeight: '800' },
  unreadPill: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 5,
    backgroundColor: colors.ocean,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadPillText: { color: colors.white, fontSize: 10, fontWeight: '800' },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', padding: spacing.lg },
  pressed: { opacity: 0.6 },
});
