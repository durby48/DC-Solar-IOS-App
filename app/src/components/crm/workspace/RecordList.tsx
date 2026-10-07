import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, type ReactNode } from 'react';
import { FlatList, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { KEYPAD_FAB_GUTTER } from '@/components/KeypadFab';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { formatPhone } from '@/lib/comms';
import { type RecordFilter, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { zipOf } from '@/lib/crmFilters';
import { TEMPERATURE_META } from '@/lib/leadTemperature';
import { type LeadStatus } from '@/lib/sales';

/**
 * A lead row's status bubble (2026-10-08). One bubble says both "this is a
 * lead" and where it stands — it replaced a LEAD pill plus "Lead · New lead ·
 * <list name>" in the line, which repeated itself and got cut off.
 */
const LEAD_PILL: Record<LeadStatus, { label: string; bg: string; fg: string }> = {
  new: { label: 'NEW', bg: colors.amberSoft, fg: colors.amberDeep },
  contacted: { label: 'CONTACTED', bg: colors.skySoft, fg: colors.ocean },
  interested: { label: 'INTERESTED', bg: colors.oliveSoft, fg: colors.olive },
  scheduled: { label: 'BOOKED', bg: colors.violetSoft, fg: colors.violet },
  visit_done: { label: 'VISIT DONE', bg: colors.violetSoft, fg: colors.violet },
  estimating: { label: 'ESTIMATING', bg: colors.tan, fg: colors.inkSoft },
  won: { label: 'WON', bg: colors.oliveSoft, fg: colors.success },
  lost: { label: 'NOT INTERESTED', bg: colors.dangerSoft, fg: colors.danger },
};

/** "4521 Troost Ave · 64110" — the street line and the ZIP, for a lead row. */
function shortAddress(r: WorkspaceRecord): string | null {
  const a = r.address?.trim();
  if (!a) return null;
  const street = a.split(',')[0].trim();
  const zip = zipOf(r);
  return zip && !street.endsWith(zip) ? `${street} · ${zip}` : street;
}

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
 *
 * Desktop (Phase 8): the selected row carries a left accent bar and a white
 * ground — Chatwoot's active-conversation treatment, where a tint alone was
 * invisible on this palette. `/` focuses the search box from anywhere on the
 * page; ↑ / ↓ in it move the selection, Enter opens the top match, Esc
 * clears. All web-only listeners, no-ops on a phone.
 *
 * A fifth lens, Jobs (2026-09-12), keeps this list as it is and asks the
 * workspace to swap its centre and detail columns for the Pipeline's
 * stage-column board. The lens chips and the selected-row accent take the
 * CRM hub's purple; the Jobs chip alone takes the Pipeline's blue when
 * selected, because what it opens is the Pipeline.
 *
 * SALES VIEW (2026-10-05, `salesView`): a sales rep's lenses are All ·
 * Prospects (leads nobody has contacted) · Leads (contacted onward) ·
 * Customers · Tasks; no Jobs lens. The add button reads "New prospect". Sign
 * out and Security live on the Sales Home (2026-10-06), not here.
 */

export type ListMode = RecordFilter | 'tasks' | 'jobs';

/**
 * One lens chip. The kit's `Chip` has fixed tones and none of them is the
 * CRM hub's purple, so the lens row draws its own — same shape, same 28px
 * hit height, the hub colour for the fill.
 */
function LensChip({
  label,
  selected,
  onPress,
  hue = hubColors.crm,
  attention = false,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  hue?: { fg: string; bg: string; deep: string };
  /** Unselected but wants a look: the Tasks chip with something due. */
  attention?: boolean;
}) {
  const bg = selected ? hue.fg : attention ? colors.amberSoft : hue.bg;
  const fg = selected ? colors.textInverse : attention ? colors.amberDeep : hue.deep;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={({ pressed }) => [styles.lens, { backgroundColor: bg }, pressed && styles.pressed]}>
      <Text style={[styles.lensText, { color: fg }]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

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
  jobsLens = false,
  jobCount,
  salesView = false,
  onImport,
  onMap,
  onFilter,
  filterCount = 0,
  replaceList,
  ownerOf,
  unassignedCount,
  listHeader,
}: {
  records: WorkspaceRecord[];
  /** `prospects` / `working` split `leads` for the sales view. */
  total: { customers: number; leads: number; prospects: number; working: number; notInterested: number };
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
  /** Offer the Jobs lens (the workspace renders the board itself). */
  jobsLens?: boolean;
  /** Open (not Complete) projects, for the Jobs chip. Omitted until known. */
  jobCount?: number;
  /** The sales rep's lenses and wording (see the header comment). */
  salesView?: boolean;
  /** Admins: the Import leads button beside New lead (2026-10-07). */
  onImport?: () => void;
  /** The Lead map button (2026-10-07), for reps and admins. */
  onMap?: () => void;
  /** The Filter & sort button (2026-10-07); `filterCount` badges it. */
  onFilter?: () => void;
  filterCount?: number;
  /** Shown in place of the list (the open Filter & sort panel). */
  replaceList?: ReactNode;
  /**
   * Admins + sales managers (2026-10-07): who owns a lead, shown as a chip on
   * its row ("Jamie", "Unassigned"). null = no chip (customers).
   */
  ownerOf?: (record: WorkspaceRecord) => { label: string; color: string } | null;
  /** Admins: leads nobody has been given — shows the Unassigned lens. */
  unassignedCount?: number;
  /** Shown above the list (the Unassigned lens's bulk-assign bar). */
  listHeader?: ReactNode;
}) {
  const searchRef = useRef<TextInput>(null);
  const listRef = useRef<FlatList<WorkspaceRecord>>(null);

  // "/" anywhere on the page → the search box (web only).
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const step = (delta: 1 | -1) => {
    if (records.length === 0) return;
    const index = records.findIndex((r) => r.key === selectedKey);
    const next = index === -1 ? (delta === 1 ? 0 : records.length - 1) : Math.min(records.length - 1, Math.max(0, index + delta));
    onSelect(records[next]);
    try {
      listRef.current?.scrollToIndex({ index: next, viewPosition: 0.5, animated: false });
    } catch {
      // A row not yet measured: FlatList throws, the selection still moved.
    }
  };

  const onSearchKey = (key: string) => {
    if (key === 'ArrowDown') step(1);
    else if (key === 'ArrowUp') step(-1);
    else if (key === 'Enter') {
      if (records[0] && !records.some((r) => r.key === selectedKey)) onSelect(records[0]);
    } else if (key === 'Escape') {
      onSearch('');
      searchRef.current?.blur();
    }
  };

  const renderRow = ({ item }: { item: WorkspaceRecord }) => {
    const selected = item.key === selectedKey;
    const unread = item.unread > 0;
    return (
      <Pressable
        onPress={() => onSelect(item)}
        style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}>
        <View style={[styles.accent, selected && styles.accentSelected]} />
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
              <View style={[styles.leadPill, { backgroundColor: (LEAD_PILL[item.lead?.status ?? 'new'] ?? LEAD_PILL.new).bg }]}>
                <Text style={[styles.leadPillText, { color: (LEAD_PILL[item.lead?.status ?? 'new'] ?? LEAD_PILL.new).fg }]}>
                  {(LEAD_PILL[item.lead?.status ?? 'new'] ?? LEAD_PILL.new).label}
                </Text>
              </View>
            ) : null}
            {item.lead?.temperature && TEMPERATURE_META[item.lead.temperature] ? (
              <Ionicons
                name={TEMPERATURE_META[item.lead.temperature].icon}
                size={13}
                color={TEMPERATURE_META[item.lead.temperature].color}
                accessibilityLabel={TEMPERATURE_META[item.lead.temperature].label}
              />
            ) : null}
            {ownerOf && ownerOf(item) ? (
              <View style={[styles.ownerPill, { borderColor: ownerOf(item)!.color }]}>
                <Text style={[styles.ownerPillText, { color: ownerOf(item)!.color }]} numberOfLines={1}>
                  {ownerOf(item)!.label}
                </Text>
              </View>
            ) : null}
            <Text style={styles.subtitle} numberOfLines={1}>
              {(item.kind === 'lead' ? shortAddress(item) : item.subtitle ?? item.address) ??
                (item.phoneE164 ? formatPhone(item.phoneE164) : '')}
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
      <View style={[styles.searchRow, salesView && { marginRight: KEYPAD_FAB_GUTTER }]}>
        <Ionicons name="search" size={15} color={colors.inkSoft} />
        <TextInput
          ref={searchRef}
          value={search}
          onChangeText={onSearch}
          onKeyPress={(e) => onSearchKey(e.nativeEvent.key)}
          placeholder={kind === 'tasks' ? 'Search tasks' : kind === 'jobs' ? 'Search the board' : 'Search name, phone, address, job #'}
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {search ? (
          <Pressable onPress={() => onSearch('')} hitSlop={8} accessibilityLabel="Clear search">
            <Ionicons name="close-circle" size={15} color={colors.inkSoft} />
          </Pressable>
        ) : Platform.OS === 'web' ? (
          <Text style={styles.kbd}>/</Text>
        ) : null}
        {onNewLead ? (
          <Pressable
            onPress={onNewLead}
            hitSlop={6}
            accessibilityLabel={salesView ? 'New prospect' : 'New lead'}
            style={({ pressed }) => [styles.newLead, pressed && styles.pressed]}>
            <Ionicons name="person-add-outline" size={15} color={hubColors.crm.fg} />
          </Pressable>
        ) : null}
        {onFilter ? (
          <Pressable
            onPress={onFilter}
            hitSlop={6}
            accessibilityLabel={filterCount ? `Filter and sort, ${filterCount} on` : 'Filter and sort'}
            style={({ pressed }) => [styles.newLead, filterCount > 0 && styles.filterOn, pressed && styles.pressed]}>
            <Ionicons name="options-outline" size={15} color={filterCount > 0 ? colors.white : hubColors.crm.fg} />
            {filterCount > 0 ? <Text style={styles.filterBadge}>{filterCount}</Text> : null}
          </Pressable>
        ) : null}
        {onMap ? (
          <Pressable
            onPress={onMap}
            hitSlop={6}
            accessibilityLabel="Lead map"
            style={({ pressed }) => [styles.newLead, pressed && styles.pressed]}>
            <Ionicons name="map-outline" size={15} color={hubColors.crm.fg} />
          </Pressable>
        ) : null}
        {onImport ? (
          <Pressable
            onPress={onImport}
            hitSlop={6}
            accessibilityLabel="Import leads"
            style={({ pressed }) => [styles.newLead, pressed && styles.pressed]}>
            <Ionicons name="cloud-upload-outline" size={15} color={hubColors.crm.fg} />
          </Pressable>
        ) : null}
      </View>
      <View style={styles.filters}>
        <LensChip label={`All ${total.customers + total.leads}`} selected={kind === 'all'} onPress={() => onKind('all')} />
        {salesView ? (
          <>
            <LensChip label={`Prospects ${total.prospects}`} selected={kind === 'prospect'} onPress={() => onKind('prospect')} />
            <LensChip label={`Leads ${total.working}`} selected={kind === 'working'} onPress={() => onKind('working')} />
            <LensChip label={`Customers ${total.customers}`} selected={kind === 'customer'} onPress={() => onKind('customer')} />
            {unassignedCount !== undefined && (unassignedCount > 0 || kind === 'unassigned') ? (
              <LensChip
                label={`Unassigned ${unassignedCount}`}
                selected={kind === 'unassigned'}
                attention={unassignedCount > 0 && kind !== 'unassigned'}
                onPress={() => onKind('unassigned')}
              />
            ) : null}
          </>
        ) : (
          <>
            <LensChip label={`Customers ${total.customers}`} selected={kind === 'customer'} onPress={() => onKind('customer')} />
            <LensChip label={`Leads ${total.leads}`} selected={kind === 'lead'} onPress={() => onKind('lead')} />
            {unassignedCount !== undefined && (unassignedCount > 0 || kind === 'unassigned') ? (
              <LensChip
                label={`Unassigned ${unassignedCount}`}
                selected={kind === 'unassigned'}
                attention={unassignedCount > 0 && kind !== 'unassigned'}
                onPress={() => onKind('unassigned')}
              />
            ) : null}
          </>
        )}
        {total.notInterested > 0 || kind === 'not_interested' ? (
          <LensChip
            label={`Not interested ${total.notInterested}`}
            selected={kind === 'not_interested'}
            onPress={() => onKind('not_interested')}
          />
        ) : null}
        {tasksPane ? (
          <LensChip
            label={taskBadge ? `Tasks ${taskBadge}` : 'Tasks'}
            selected={kind === 'tasks'}
            attention={taskBadge > 0 && kind !== 'tasks'}
            onPress={() => onKind('tasks')}
          />
        ) : null}
        {jobsLens ? (
          <LensChip
            label={jobCount != null ? `Jobs ${jobCount}` : 'Jobs'}
            selected={kind === 'jobs'}
            hue={hubColors.pipeline}
            onPress={() => onKind('jobs')}
          />
        ) : null}
      </View>
      {kind !== 'tasks' && !replaceList && listHeader ? listHeader : null}
      {kind !== 'tasks' && replaceList ? (
        replaceList
      ) : kind === 'tasks' && tasksPane ? (
        tasksPane
      ) : (
        <FlatList
          ref={listRef}
          data={records}
          keyExtractor={(item) => item.key}
          onScrollToIndexFailed={() => {
            // Unmeasured rows: nothing to do, the selection already moved.
          }}
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
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 6,
  },
  // minWidth 0 lets the box shrink on a narrow screen, so the round buttons
  // (new, filter, map, import) always fit — the map one was getting cut off.
  searchInput: { flex: 1, minWidth: 0, color: colors.ink, fontSize: 14, fontWeight: '500', paddingVertical: 2 },
  filters: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingBottom: spacing.xs,
  },
  lens: {
    height: 28,
    paddingHorizontal: spacing.sm + 2,
    borderRadius: radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lensText: { fontSize: 12, fontWeight: '700' },
  newLead: { width: 26, height: 26, flexShrink: 0, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: hubColors.crm.bg },
  kbd: {
    color: colors.inkSoft,
    fontSize: 10,
    fontWeight: '800',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.sm + 2,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowSelected: { backgroundColor: colors.surface },
  accent: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: 'transparent', marginRight: -2 },
  accentSelected: { backgroundColor: hubColors.crm.fg },
  rowPressed: { backgroundColor: hubColors.crm.bg },
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
    backgroundColor: hubColors.crm.fg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadPillText: { color: colors.textInverse, fontSize: 10, fontWeight: '800' },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', padding: spacing.lg },
  pressed: { opacity: 0.6 },
  // Filter button lit up while filters are on, with their count (2026-10-07).
  filterOn: { backgroundColor: hubColors.crm.fg, flexDirection: 'row', gap: 2, width: undefined, paddingHorizontal: 8 },
  filterBadge: { color: colors.white, fontSize: 11, fontWeight: '800' },
  // Lead owner chip (admins + sales managers, 2026-10-07).
  ownerPill: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1, maxWidth: 90 },
  ownerPillText: { fontSize: 9, fontWeight: '800' },
});
