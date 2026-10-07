import Ionicons from '@expo/vector-icons/Ionicons';
import { router, Stack, useFocusEffect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ZipPicker } from '@/components/crm/workspace/FilterPanel';
import { AppText, Chip, Screen } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { applyFilters, EMPTY_FILTERS, filterOptions, STAGE_LABEL, zipOf, type CrmFilters, type Stage } from '@/lib/crmFilters';
import { fetchWorkspaceRecords, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { assignLeads } from '@/lib/leadImport';
import { TEMPERATURE_META, TEMPERATURES, type LeadTemperature } from '@/lib/leadTemperature';
import { useRoleGate } from '@/lib/role';
import { fetchSalesTeam, removeLeads, removeSummary } from '@/lib/sales';
import { firstName } from '@/lib/staffNames';

/**
 * `/assign-leads` — hand out leads (2026-10-08). Sales manager: Settings →
 * Selling → Assign leads; admins: the CRM hub; developers: Settings too.
 *
 * The page is the LEADS: search + Filter (owner, ZIP, stage, installer, never
 * contacted, has a phone, order — oldest first by default; the CRM's own
 * filter code, lib/crmFilters.ts), then the list with a checkbox per lead.
 * One button at the bottom changes with the selection:
 *
 *   nothing ticked  "Hand out leads…"  → How many (from the top of the list)
 *                                        + Give to
 *   leads ticked    "Assign N selected…" → Give to
 *
 * Give to: one rep, or several = split evenly. Each rep gets a RUN of the
 * list (not every other lead), so sorted by ZIP each keeps one area. The
 * panel's last button spells out what will happen before anything does.
 *
 * assign_leads() does the work (admins + sales managers; it reassigns any
 * lead, skips leads the rep already has, and sends each rep one "N new
 * prospects" push per batch).
 */

type From = 'all' | 'unassigned' | string;
type Order = 'oldest' | 'newest' | 'zip';
const STAGES: Stage[] = ['prospect', 'contacted', 'interested', 'closed', 'booked'];
const ORDER_LABEL: Record<Order, string> = { oldest: 'Oldest first', newest: 'Newest first', zip: 'By ZIP' };
const OWNER_COLORS = ['#7C5CFF', '#2E9E6A', '#D9822B', '#2F7FD1', '#C2416B', '#8A6D3B'];

function first(name: string): string {
  return name.split(' ')[0] || name;
}

/** `total` split into `parts` runs whose sizes differ by at most one. */
function splitSizes(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const extra = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

function toggle<T>(list: T[], v: T): T[] {
  return list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
}

export default function AssignLeadsScreen() {
  const gate = useRoleGate();
  // A developer gets in through a role view (Owner / Sales manager), like anyone with that role.
  const allowed = gate.role?.isAdmin === true || gate.role?.isSalesManager === true;

  if (gate.phase === 'loading') {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Assign leads' }} />
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }
  if (!allowed) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Assign leads' }} />
        <AppText variant="body" color={colors.textSecondary}>
          Assigning leads is for the sales manager and admins.
        </AppText>
      </Screen>
    );
  }
  return (
    <AssignLeads
      myEmail={gate.role?.email.toLowerCase() ?? ''}
      canRestore={gate.role?.isAdmin === true}
    />
  );
}

function AssignLeads({ myEmail, canRestore }: { myEmail: string; canRestore: boolean }) {
  const insets = useSafeAreaInsets();
  const [leads, setLeads] = useState<WorkspaceRecord[] | null>(null);
  const [team, setTeam] = useState<{ email: string; name: string }[]>([]);
  // Filters
  const [search, setSearch] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [from, setFrom] = useState<From | null>(null);
  const [zips, setZips] = useState<string[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [installers, setInstallers] = useState<string[]>([]);
  const [neverContacted, setNeverContacted] = useState(false);
  const [hasPhone, setHasPhone] = useState(false);
  const [temps, setTemps] = useState<LeadTemperature[]>([]);
  const [order, setOrder] = useState<Order>('oldest');
  // Selection + the panel
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  // Remove the ticked leads (2026-10-08): a confirm sheet, then remove_leads().
  const [removeOpen, setRemoveOpen] = useState(false);
  const [howMany, setHowMany] = useState<number | 'all'>(25);
  const [typed, setTyped] = useState('');
  const [to, setTo] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const [result, people] = await Promise.all([fetchWorkspaceRecords(), fetchSalesTeam()]);
    const open = result.records.filter((r) => r.kind === 'lead');
    setLeads(open);
    setTeam(people.map((p) => ({ email: p.email.toLowerCase(), name: p.name })));
    setFrom((cur) => cur ?? 'all');
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const nameOf = useCallback(
    (email: string) => team.find((t) => t.email === email)?.name ?? email.split('@')[0],
    [team],
  );
  const colorOf = useCallback(
    (email: string) => OWNER_COLORS[Math.max(0, team.findIndex((t) => t.email === email)) % OWNER_COLORS.length],
    [team],
  );

  // Owner counts (the Owner filter's chips).
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of leads ?? []) {
      const owner = r.lead?.assigned_to?.toLowerCase() ?? '';
      m.set(owner, (m.get(owner) ?? 0) + 1);
    }
    return m;
  }, [leads]);
  const owners = useMemo(() => {
    const emails = new Set([...team.map((t) => t.email), ...[...counts.keys()].filter(Boolean)]);
    return [...emails].map((e) => ({ email: e, name: nameOf(e), count: counts.get(e) ?? 0 }));
  }, [team, counts, nameOf]);

  const fromPool = useMemo(() => {
    const all = leads ?? [];
    if (from === 'unassigned') return all.filter((r) => !r.lead?.assigned_to);
    if (from && from !== 'all') return all.filter((r) => r.lead?.assigned_to?.toLowerCase() === from);
    return all;
  }, [leads, from]);
  const options = useMemo(() => filterOptions(fromPool), [fromPool]);
  const matches = useMemo(() => {
    const f: CrmFilters = {
      ...EMPTY_FILTERS,
      zips,
      stages,
      installers,
      contact: neverContacted ? ['never'] : [],
      has: hasPhone ? ['phone'] : [],
      temps,
      sort: order,
    };
    const q = search.trim().toLowerCase();
    return applyFilters(fromPool, f, []).filter(
      (r) => !q || r.name.toLowerCase().includes(q) || (r.address ?? '').toLowerCase().includes(q),
    );
  }, [fromPool, zips, stages, installers, neverContacted, hasPhone, temps, order, search]);

  const filterCount =
    (from && from !== 'all' ? 1 : 0) + zips.length + stages.length + installers.length + temps.length + (neverContacted ? 1 : 0) + (hasPhone ? 1 : 0);

  // What the panel will hand out: the ticked leads (in list order), or the
  // first N of the list. Leads a chosen rep already has are left out.
  // Only ticked leads still in the (filtered) list count.
  const selectedInList = matches.reduce((n, r) => n + (selected.has(r.id) ? 1 : 0), 0);
  const picking = selectedInList > 0;
  const toSet = new Set(to);
  const base = (picking ? matches.filter((r) => selected.has(r.id)) : matches).filter(
    (r) => !toSet.has(r.lead?.assigned_to?.toLowerCase() ?? ''),
  );
  const typedN = Number.parseInt(typed, 10);
  const want = picking
    ? base.length
    : typed
      ? Number.isFinite(typedN) && typedN > 0
        ? typedN
        : 0
      : howMany === 'all'
        ? base.length
        : howMany;
  const take = Math.min(want, base.length);
  const sizes = to.length > 0 ? splitSizes(take, to.length) : [];
  const confirmText =
    to.length === 0
      ? 'Pick who gets them'
      : take === 0
        ? 'Nothing to give'
        : to.length === 1
          ? `Give ${take} lead${take === 1 ? '' : 's'} to ${firstName(nameOf(to[0]))}`
          : `Split ${take} leads: ${to.map((e, i) => `${first(nameOf(e))} ${sizes[i]}`).join(', ')}`;

  const run = async () => {
    if (to.length === 0 || take === 0) return;
    setBusy(true);
    const picked = base.slice(0, take);
    const done: string[] = [];
    let offset = 0;
    for (let i = 0; i < to.length; i++) {
      const ids = picked.slice(offset, offset + sizes[i]).map((r) => r.id);
      offset += sizes[i];
      if (ids.length === 0) continue;
      const result = await assignLeads(ids, to[i]);
      if (!result.ok) {
        setBusy(false);
        setSheetOpen(false);
        setNote({ ok: false, text: `${done.length ? `${done.join(', ')}. ` : ''}Stopped: ${result.message}` });
        void load();
        return;
      }
      done.push(`Gave ${result.count} to ${first(nameOf(to[i]))}`);
    }
    setBusy(false);
    setSheetOpen(false);
    setSelected(new Set());
    setTo([]);
    setTyped('');
    setNote({ ok: true, text: `${done.join(', ')}.` });
    void load();
  };

  const runRemove = async () => {
    const ids = matches.filter((r) => selected.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    setBusy(true);
    const result = await removeLeads(ids);
    setBusy(false);
    setRemoveOpen(false);
    if (result.ok) {
      setSelected(new Set());
      setNote({ ok: result.removed > 0, text: removeSummary(result) });
    } else {
      setNote({ ok: false, text: result.message });
    }
    void load();
  };

  if (!leads || from === null) {
    return (
      <Screen edges={[]}>
        <Stack.Screen options={{ title: 'Assign leads' }} />
        <ActivityIndicator color={hubColors.crm.fg} style={styles.loading} />
      </Screen>
    );
  }

  const header = (
    <View style={styles.header}>
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Ionicons name="search" size={15} color={colors.inkSoft} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search name or address"
            placeholderTextColor={colors.inkSoft}
            style={styles.searchInput}
          />
          {search ? (
            <Pressable onPress={() => setSearch('')} hitSlop={8}>
              <Ionicons name="close-circle" size={16} color={colors.inkSoft} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => setFilterOpen((v) => !v)}
          style={({ pressed }) => [styles.filterButton, (filterOpen || filterCount > 0) && styles.filterButtonOn, pressed && styles.pressed]}>
          <Ionicons name="options" size={15} color={filterOpen || filterCount > 0 ? colors.white : hubColors.crm.deep} />
          <Text style={[styles.filterText, (filterOpen || filterCount > 0) && styles.filterTextOn]}>
            Filter{filterCount ? ` · ${filterCount}` : ''}
          </Text>
        </Pressable>
      </View>

      {filterOpen ? (
        <View style={styles.panel}>
          <Text style={styles.label}>Owner</Text>
          <View style={styles.chips}>
            <Chip label={`Everyone · ${leads.length}`} tone="ocean" selected={from === 'all'} onPress={() => setFrom('all')} />
            {owners.map((p) => (
              <Chip
                key={p.email}
                label={`${p.email === myEmail ? 'You' : first(p.name)} · ${p.count}`}
                tone="ocean"
                selected={from === p.email}
                onPress={() => setFrom(p.email)}
              />
            ))}
            <Chip
              label={`Unassigned · ${counts.get('') ?? 0}`}
              tone="ocean"
              selected={from === 'unassigned'}
              onPress={() => setFrom('unassigned')}
            />
          </View>

          <Text style={styles.label}>ZIP code</Text>
          {options.zips.length === 0 ? (
            <AppText variant="caption" color={colors.textSecondary}>
              No ZIP codes in these leads.
            </AppText>
          ) : (
            <ZipPicker zips={options.zips} selected={zips} onToggle={(z) => setZips((l) => toggle(l, z))} />
          )}

          <Text style={styles.label}>Stage</Text>
          <View style={styles.chips}>
            {STAGES.map((s) => (
              <Chip key={s} label={STAGE_LABEL[s]} selected={stages.includes(s)} onPress={() => setStages((l) => toggle(l, s))} />
            ))}
          </View>

          <Text style={styles.label}>Temperature</Text>
          <View style={styles.chips}>
            {TEMPERATURES.map((t) => (
              <Chip
                key={t}
                label={TEMPERATURE_META[t].label}
                icon={TEMPERATURE_META[t].icon}
                selected={temps.includes(t)}
                onPress={() => setTemps((l) => toggle(l, t))}
              />
            ))}
          </View>

          {options.installers.length > 0 ? (
            <>
              <Text style={styles.label}>Original installer</Text>
              <View style={styles.chips}>
                {options.installers.map((o) => (
                  <Chip
                    key={o.value}
                    label={`${o.value} · ${o.count}`}
                    selected={installers.includes(o.value)}
                    onPress={() => setInstallers((l) => toggle(l, o.value))}
                  />
                ))}
              </View>
            </>
          ) : null}

          <Text style={styles.label}>Only</Text>
          <View style={styles.chips}>
            <Chip label="Never contacted" selected={neverContacted} onPress={() => setNeverContacted((v) => !v)} />
            <Chip label="Has a phone" selected={hasPhone} onPress={() => setHasPhone((v) => !v)} />
          </View>

          <Text style={styles.label}>Order</Text>
          <View style={styles.chips}>
            {(Object.keys(ORDER_LABEL) as Order[]).map((o) => (
              <Chip key={o} label={ORDER_LABEL[o]} selected={order === o} onPress={() => setOrder(o)} />
            ))}
          </View>

          <View style={styles.panelFoot}>
            {filterCount > 0 ? (
              <Pressable
                onPress={() => {
                  setFrom('all');
                  setZips([]);
                  setStages([]);
                  setInstallers([]);
                  setNeverContacted(false);
                  setHasPhone(false);
                  setTemps([]);
                }}
                hitSlop={8}>
                <Text style={styles.link}>Clear filters</Text>
              </Pressable>
            ) : (
              <View />
            )}
            <Pressable onPress={() => setFilterOpen(false)} style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}>
              <Text style={styles.doneText}>Show {matches.length}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {note ? (
        <Text style={[styles.note, !note.ok && styles.noteBad]}>{note.text}</Text>
      ) : null}

      <View style={styles.countRow}>
        <Text style={styles.countText}>
          {matches.length} lead{matches.length === 1 ? '' : 's'}
          {picking ? ` · ${selectedInList} selected` : ''}
        </Text>
        <View style={styles.countActions}>
          <Pressable onPress={() => setSelected(new Set(matches.map((r) => r.id)))} hitSlop={8}>
            <Text style={styles.link}>Select all</Text>
          </Pressable>
          {picking ? (
            <Pressable onPress={() => setSelected(new Set())} hitSlop={8}>
              <Text style={styles.link}>Clear</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </View>
  );

  return (
    <Screen edges={[]} scroll={false} padded={false}>
      <Stack.Screen options={{ title: 'Assign leads' }} />
      <FlatList
        data={matches}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={header}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: 96 + insets.bottom }]}
        ListFooterComponent={
          canRestore ? (
            <Pressable onPress={() => router.push('/removed-leads' as never)} style={styles.removedLink} hitSlop={8}>
              <Ionicons name="trash-outline" size={14} color={colors.inkSoft} />
              <Text style={styles.removedLinkText}>Removed leads</Text>
            </Pressable>
          ) : null
        }
        ListEmptyComponent={
          <AppText variant="body" color={colors.textSecondary} style={styles.empty}>
            No leads match. Clear a filter or the search.
          </AppText>
        }
        renderItem={({ item }) => {
          const on = selected.has(item.id);
          const owner = item.lead?.assigned_to?.toLowerCase() ?? null;
          const zip = zipOf(item);
          return (
            <Pressable
              onPress={() =>
                setSelected((cur) => {
                  const next = new Set(cur);
                  if (next.has(item.id)) next.delete(item.id);
                  else next.add(item.id);
                  return next;
                })
              }
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              style={({ pressed }) => [styles.row, on && styles.rowOn, pressed && styles.pressed]}>
              <Ionicons name={on ? 'checkbox' : 'square-outline'} size={20} color={on ? hubColors.crm.fg : colors.inkSoft} />
              <View style={styles.rowBody}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {item.name}
                </Text>
                {item.address ? (
                  <Text style={styles.rowSub} numberOfLines={1}>
                    {item.address}
                  </Text>
                ) : null}
              </View>
              <View style={styles.rowMeta}>
                <View style={[styles.ownerChip, { backgroundColor: owner ? colorOf(owner) : colors.inkSoft }]}>
                  <Text style={styles.ownerText} numberOfLines={1}>
                    {owner ? (owner === myEmail ? 'You' : first(nameOf(owner))) : 'Unassigned'}
                  </Text>
                </View>
                {zip ? <Text style={styles.zip}>{zip}</Text> : null}
              </View>
            </Pressable>
          );
        }}
      />

      <View style={[styles.bottom, styles.bottomRow, { paddingBottom: spacing.sm + insets.bottom }]}>
        {picking ? (
          <Pressable
            onPress={() => setRemoveOpen(true)}
            style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}
            accessibilityLabel={`Remove ${selectedInList} selected`}>
            <Ionicons name="trash-outline" size={16} color={colors.danger} />
          </Pressable>
        ) : null}
        <Pressable
          onPress={() => {
            setTo([]);
            setSheetOpen(true);
          }}
          disabled={matches.length === 0}
          style={({ pressed }) => [styles.mainButton, matches.length === 0 && styles.off, pressed && styles.pressed]}>
          <Ionicons name="people" size={16} color={colors.textOnAction} />
          <Text style={styles.mainText}>
            {picking ? `Assign ${selectedInList} selected…` : 'Hand out leads…'}
          </Text>
        </Pressable>
      </View>

      <Modal visible={removeOpen} transparent animationType="slide" onRequestClose={() => setRemoveOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => !busy && setRemoveOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: spacing.md + insets.bottom }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>
              Remove {selectedInList} lead{selectedInList === 1 ? '' : 's'}?
            </Text>
            <Pressable onPress={() => setRemoveOpen(false)} hitSlop={8} disabled={busy}>
              <Ionicons name="close" size={20} color={colors.inkSoft} />
            </Pressable>
          </View>
          <AppText variant="body" color={colors.textSecondary}>
            They disappear from the CRM, the map and every count. Leads with a booked visit are skipped. An admin can
            restore them from Removed leads.
          </AppText>
          <Pressable
            onPress={() => void runRemove()}
            disabled={busy}
            style={({ pressed }) => [styles.mainButton, styles.removeConfirm, (pressed || busy) && styles.pressed]}>
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.removeConfirmText}>
                Remove {selectedInList} lead{selectedInList === 1 ? '' : 's'}
              </Text>
            )}
          </Pressable>
        </View>
      </Modal>

      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => !busy && setSheetOpen(false)} />
        <View style={[styles.sheet, { paddingBottom: spacing.md + insets.bottom }]}>
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>
              {picking ? `Assign ${selectedInList} selected lead${selectedInList === 1 ? '' : 's'}` : 'Hand out leads'}
            </Text>
            <Pressable onPress={() => setSheetOpen(false)} hitSlop={8} disabled={busy}>
              <Ionicons name="close" size={20} color={colors.inkSoft} />
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            {!picking ? (
              <>
                <Text style={styles.label}>How many</Text>
                <View style={styles.chips}>
                  {([10, 25, 50, 'all'] as const).map((n) => (
                    <Chip
                      key={String(n)}
                      label={n === 'all' ? `All ${matches.length}` : String(n)}
                      selected={!typed && howMany === n}
                      onPress={() => {
                        setTyped('');
                        setHowMany(n);
                      }}
                    />
                  ))}
                  <TextInput
                    value={typed}
                    onChangeText={(t) => setTyped(t.replace(/[^0-9]/g, ''))}
                    placeholder="Other"
                    placeholderTextColor={colors.inkSoft}
                    keyboardType="number-pad"
                    maxLength={4}
                    style={[styles.numberInput, typed ? styles.numberInputOn : null]}
                  />
                </View>
                <AppText variant="caption" color={colors.textSecondary}>
                  From the top of the list ({ORDER_LABEL[order].toLowerCase()}).
                </AppText>
              </>
            ) : null}

            <Text style={styles.label}>Give to</Text>
            <View style={styles.chips}>
              {team.map((t) => (
                <Chip
                  key={t.email}
                  label={t.email === myEmail ? `${firstName(t.name)} (you)` : firstName(t.name)}
                  tone="sun"
                  selected={to.includes(t.email)}
                  onPress={() => setTo((l) => toggle(l, t.email))}
                />
              ))}
            </View>
            <AppText variant="caption" color={colors.textSecondary}>
              Pick two or more to split them evenly. Each rep gets one notification.
            </AppText>
          </ScrollView>
          <Pressable
            onPress={() => void run()}
            disabled={busy || to.length === 0 || take === 0}
            style={({ pressed }) => [
              styles.mainButton,
              (to.length === 0 || take === 0) && styles.off,
              (pressed || busy) && styles.pressed,
            ]}>
            {busy ? <ActivityIndicator color={colors.textOnAction} /> : <Text style={styles.mainText}>{confirmText}</Text>}
          </Pressable>
        </View>
      </Modal>
    </Screen>
  );
}

const styles = StyleSheet.create({
  loading: { marginVertical: spacing.xl },
  list: { width: '100%', maxWidth: 720, alignSelf: 'center' },
  header: { padding: spacing.md, paddingBottom: spacing.xs, gap: spacing.sm },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '600', paddingVertical: 8 },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: 8,
    borderRadius: radii.pill,
    backgroundColor: hubColors.crm.bg,
  },
  filterButtonOn: { backgroundColor: hubColors.crm.fg },
  filterText: { color: hubColors.crm.deep, fontSize: 13, fontWeight: '800' },
  filterTextOn: { color: colors.white },
  panel: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  panelFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xs },
  label: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, alignItems: 'center' },
  link: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  doneButton: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 8 },
  doneText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  note: { color: colors.success, fontSize: 13, fontWeight: '800' },
  noteBad: { color: colors.danger },
  countRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: spacing.xs },
  countText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  countActions: { flexDirection: 'row', gap: spacing.md },
  empty: { padding: spacing.lg, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.surface,
  },
  rowOn: { backgroundColor: hubColors.crm.bg },
  rowBody: { flex: 1, minWidth: 0 },
  rowName: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  rowSub: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', marginTop: 1 },
  rowMeta: { alignItems: 'flex-end', gap: 3, maxWidth: 110 },
  ownerChip: { borderRadius: radii.pill, paddingHorizontal: 8, paddingVertical: 2 },
  ownerText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  zip: { color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    alignItems: 'center',
  },
  mainButton: {
    flex: 1,
    maxWidth: 520,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 4,
    paddingHorizontal: spacing.md,
    alignSelf: 'center',
  },
  mainText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800', textAlign: 'center' },
  bottomRow: { flexDirection: 'row', justifyContent: 'center', gap: spacing.sm },
  removeButton: {
    width: 46,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  removeConfirm: { backgroundColor: colors.danger },
  removeConfirmText: { color: '#fff', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  removedLink: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'center', padding: spacing.lg },
  removedLinkText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  off: { opacity: 0.45 },
  pressed: { opacity: 0.6 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    gap: spacing.sm,
    maxHeight: '80%',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' },
  sheetBody: { gap: spacing.sm, paddingBottom: spacing.sm },
  numberInput: {
    minWidth: 72,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    color: colors.ink,
    fontSize: 12,
    fontWeight: '700',
  },
  numberInputOn: { borderColor: hubColors.crm.fg },
});
