import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { Chip, WheelPickerSheet, type WheelOption } from '@/components/ui';
import { colors, radii, shadows, spacing, typography } from '@/constants/theme';
import { fetchEnrolledCustomerIds } from '@/lib/account';
import {
  addCustomer,
  convertLeadToCustomer,
  fetchCrmCustomers,
  fetchCustomerAvatarUrls,
  fetchCustomerHouseArtUrls,
  fetchCustomerSummaries,
  fetchUnreadByCustomer,
  type CustomerSummary,
} from '@/lib/crm';
import { useRole } from '@/lib/role';
import { fetchOpenLeads, type Lead } from '@/lib/sales';
import { supabase } from '@/lib/supabase';
import { type Customer } from '@/lib/types';

/**
 * The CRM customer list.
 *
 * Lives in `components/` rather than in the route file because it has two
 * homes: `/crm` today (a root-stack route, so it gets a header and a back
 * button) and the `Customers` tab in Phase 3. The route file is a shell; this
 * is the screen.
 *
 * WHAT IT REPLACED. `more/customers.tsx` was a flat contact book: search by
 * name only, no sort, no counts, an inline edit form and one signed-URL
 * request per rendered avatar. Everything it could do still exists — the
 * contact rows, the photo picker, the insurance documents, Invite, add and
 * edit all moved onto `crm/[id].tsx` — and this screen adds the part that was
 * missing: who owes money, who has work open, who is in the portal, and which
 * leads have not been turned into anybody yet.
 */

type SortKey = 'name' | 'nameDesc' | 'recent' | 'balance' | 'jobs';
type FilterKey =
  | 'all'
  | 'openJobs'
  | 'balance'
  | 'inPortal'
  | 'notInPortal'
  | 'leads'
  | 'archived';

/**
 * TWO WHEELS, NOT TWO ROWS OF CHIPS (2026-08-22).
 *
 * Sort and Show used to be eleven chips wrapping over three lines above the
 * list — on a phone that was most of the first screenful before a single
 * customer appeared. They are now one `Sort ▾` chip and one `Show ▾` chip,
 * each opening a scroll wheel in a bottom sheet, and each carrying its
 * current choice in its own label so nothing is hidden behind the tap.
 *
 * `Show` became SINGLE-select in the move. The old multi-select could
 * express combinations nobody used ("in portal AND balance due") while
 * "in portal AND not in portal" had to be special-cased to stop it returning
 * an empty list. One choice, `all` by default.
 *
 * `needsMetrics` options are dropped from the wheel for viewers, because
 * `crm_customer_summary` returns them zero rows — see `hasMetrics` below.
 */
const SORTS: { value: SortKey; label: string; needsMetrics: boolean }[] = [
  { value: 'name', label: 'Name A–Z', needsMetrics: false },
  { value: 'nameDesc', label: 'Name Z–A', needsMetrics: false },
  { value: 'recent', label: 'Recent activity', needsMetrics: true },
  { value: 'balance', label: 'Balance owed', needsMetrics: true },
  { value: 'jobs', label: 'Open jobs', needsMetrics: true },
];

const FILTERS: { value: FilterKey; label: string; needsMetrics: boolean }[] = [
  { value: 'all', label: 'All customers', needsMetrics: false },
  { value: 'openJobs', label: 'Has open jobs', needsMetrics: true },
  { value: 'balance', label: 'Balance due', needsMetrics: true },
  { value: 'inPortal', label: 'In portal', needsMetrics: false },
  { value: 'notInPortal', label: 'Not in portal', needsMetrics: false },
  { value: 'leads', label: 'Leads', needsMetrics: false },
  { value: 'archived', label: 'Archived', needsMetrics: false },
];

function money(amount: number): string {
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

/** Session state (role.ts returns null both while loading and signed out). */
function useAuthState(): 'loading' | 'out' | 'in' {
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setState(data.session?.user?.email ? 'in' : 'out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setState(session?.user?.email ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);
  return state;
}

/** Alert on native, inline status text on web — the app-wide split. */
function notify(
  setStatus: (s: { kind: 'success' | 'error'; message: string } | null) => void,
  kind: 'success' | 'error',
  title: string,
  message: string,
) {
  if (Platform.OS === 'web') {
    setStatus({ kind, message: `${title}: ${message}` });
  } else {
    setStatus(null);
    Alert.alert(title, message);
  }
}

interface FormState {
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: FormState = { name: '', phone: '', email: '', address: '', notes: '' };

export function CustomerList({
  onSummaryChange,
}: {
  /**
   * Reports the one-line count ("18 customers") so the tab shell can render
   * it centred under the screen title. Must be a stable identity — pass a
   * `useState` setter or a `useCallback`.
   */
  onSummaryChange?: (summary: string | null) => void;
} = {}) {
  const router = useRouter();
  const auth = useAuthState();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [listState, setListState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [summaries, setSummaries] = useState<Map<string, CustomerSummary>>(new Map());
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [houseArt, setHouseArt] = useState<Map<string, string>>(new Map());
  const [enrolled, setEnrolled] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [leads, setLeads] = useState<Lead[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [sortOpen, setSortOpen] = useState(false);
  const [showOpen, setShowOpen] = useState(false);

  const [openLeadId, setOpenLeadId] = useState<string | null>(null);
  const [convertingId, setConvertingId] = useState<string | null>(null);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  /**
   * One load.
   *
   * Wave 1 is a single `Promise.all` — customers, portal enrolment, unread
   * counts and open leads all at once. Wave 2 needs the ids wave 1 returned,
   * so it cannot be folded in: the money summaries come from one rpc for the
   * whole page and the avatars from ONE batched `createSignedUrls`, never one
   * request per row.
   *
   * Archived customers are fetched too and hidden client-side, so picking
   * Archived on the Show wheel (which is how you find the row behind a
   * duplicate-name error) never costs a round trip.
   */
  const load = useCallback(async () => {
    const [customersRes, enrolledIds, unreadCounts, leadRows] = await Promise.all([
      fetchCrmCustomers({ includeArchived: true }),
      fetchEnrolledCustomerIds(),
      fetchUnreadByCustomer(),
      fetchOpenLeads(),
    ]);

    setEnrolled(enrolledIds);
    setUnread(unreadCounts);
    setLeads(leadRows);

    if (customersRes.status !== 'ok') {
      setCustomers([]);
      setSummaries(new Map());
      setAvatarUrls(new Map());
      setHouseArt(new Map());
      setListState('unavailable');
      return;
    }

    const rows = customersRes.customers;
    setCustomers(rows);
    setListState('ok');

    const [summaryMap, urlMap, artMap] = await Promise.all([
      fetchCustomerSummaries(rows.map((c) => c.id)),
      fetchCustomerAvatarUrls(rows),
      fetchCustomerHouseArtUrls(rows),
    ]);
    setSummaries(summaryMap);
    setAvatarUrls(urlMap);
    setHouseArt(artMap);
  }, []);

  // One loader, not two: `useFocusEffect` re-runs whenever its callback
  // identity changes while the screen is focused, so it covers both the first
  // load (auth resolving from 'loading' to 'in') and every return to the tab.
  useFocusEffect(
    useCallback(() => {
      if (auth !== 'in') return;
      void load();
    }, [auth, load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  /**
   * Money metrics only exist for admins: `crm_customer_summary` returns zero
   * rows to everyone else by design, so an empty map means "no money strip",
   * not "loading failed". Wheel rows that depend on it are dropped.
   */
  const hasMetrics = summaries.size > 0;
  const leadsOnly = filter === 'leads';

  const sortOptions = useMemo<WheelOption<SortKey>[]>(
    () =>
      SORTS.filter((o) => !o.needsMetrics || hasMetrics).map(({ value, label }) => ({
        value,
        label,
      })),
    [hasMetrics],
  );
  const filterOptions = useMemo<WheelOption<FilterKey>[]>(
    () =>
      FILTERS.filter((o) => !o.needsMetrics || hasMetrics).map(({ value, label }) => ({
        value,
        label,
      })),
    [hasMetrics],
  );

  const sortLabel = SORTS.find((o) => o.value === sort)?.label ?? 'Name A–Z';
  const filterLabel = FILTERS.find((o) => o.value === filter)?.label ?? 'All customers';

  // A viewer never gets money rows back, so a money-shaped choice would sit in
  // the chip label while its row was missing from the wheel. Fall back.
  useEffect(() => {
    if (hasMetrics) return;
    if (SORTS.find((o) => o.value === sort)?.needsMetrics) setSort('name');
    if (FILTERS.find((o) => o.value === filter)?.needsMetrics) setFilter('all');
  }, [hasMetrics, sort, filter]);

  const visible = useMemo(() => {
    if (leadsOnly) return [];
    const wantArchived = filter === 'archived';
    let rows = customers.filter((c) => (wantArchived ? c.archived_at != null : c.archived_at == null));

    if (filter === 'openJobs') {
      rows = rows.filter((c) => (summaries.get(c.id)?.openJobs ?? 0) > 0);
    }
    if (filter === 'balance') {
      rows = rows.filter((c) => (summaries.get(c.id)?.balance ?? 0) > 0.005);
    }
    if (filter === 'inPortal') rows = rows.filter((c) => enrolled.has(c.id));
    if (filter === 'notInPortal') rows = rows.filter((c) => !enrolled.has(c.id));

    const q = search.trim().toLowerCase();
    if (q) {
      // Digits-only phone matching: "8165506413", "(816) 550-6413" and
      // "816-550" all have to find the same person.
      const digits = q.replace(/\D/g, '');
      rows = rows.filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        if ((c.email ?? '').toLowerCase().includes(q)) return true;
        if ((c.address ?? '').toLowerCase().includes(q)) return true;
        if (digits.length >= 3) {
          const phoneDigits = (c.phone ?? '').replace(/\D/g, '');
          if (phoneDigits.includes(digits)) return true;
        }
        return false;
      });
    }

    const byName = (a: Customer, b: Customer) =>
      a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });

    const sorted = [...rows];
    if (sort === 'name') {
      sorted.sort(byName);
    } else if (sort === 'nameDesc') {
      sorted.sort((a, b) => byName(b, a));
    } else if (sort === 'recent') {
      sorted.sort((a, b) => {
        const ta = summaries.get(a.id)?.lastActivityAt ?? '';
        const tb = summaries.get(b.id)?.lastActivityAt ?? '';
        if (ta === tb) return byName(a, b);
        return ta < tb ? 1 : -1;
      });
    } else if (sort === 'balance') {
      sorted.sort((a, b) => {
        const va = summaries.get(a.id)?.balance ?? 0;
        const vb = summaries.get(b.id)?.balance ?? 0;
        return vb - va || byName(a, b);
      });
    } else {
      sorted.sort((a, b) => {
        const va = summaries.get(a.id)?.openJobs ?? 0;
        const vb = summaries.get(b.id)?.openJobs ?? 0;
        return vb - va || byName(a, b);
      });
    }
    return sorted;
  }, [customers, summaries, enrolled, filter, search, sort, leadsOnly]);

  /**
   * The count line the tab shell renders under the centred title. Kept here
   * rather than in the route file because this is the only place that knows
   * what survived the filter.
   */
  const summaryLine = useMemo(() => {
    if (auth !== 'in' || listState !== 'ok') return null;
    if (leadsOnly) return leads.length === 1 ? '1 lead' : `${leads.length} leads`;
    if (filter === 'archived') {
      return visible.length === 1 ? '1 archived customer' : `${visible.length} archived`;
    }
    return visible.length === 1 ? '1 customer' : `${visible.length} customers`;
  }, [auth, listState, leadsOnly, filter, leads.length, visible.length]);

  useEffect(() => {
    onSummaryChange?.(summaryLine);
  }, [onSummaryChange, summaryLine]);

  const submitAdd = async () => {
    setStatus(null);
    if (!addForm.name.trim()) {
      notify(setStatus, 'error', 'Missing name', 'Give the customer a name.');
      return;
    }
    setAdding(true);
    const result = await addCustomer({
      name: addForm.name.trim(),
      phone: addForm.phone.trim() || null,
      email: addForm.email.trim() || null,
      address: addForm.address.trim() || null,
      notes: addForm.notes.trim() || null,
    });
    setAdding(false);
    if (result.ok) {
      await load();
      setShowAddForm(false);
      setAddForm(EMPTY_FORM);
      notify(setStatus, 'success', 'Customer added', `${addForm.name.trim()} is saved.`);
    } else {
      notify(setStatus, 'error', 'Could not add customer', result.message);
    }
  };

  const convert = async (lead: Lead, withJob: boolean) => {
    setStatus(null);
    setConvertingId(lead.id);
    const result = await convertLeadToCustomer(lead.id, { createJob: withJob });
    setConvertingId(null);
    if (!result.ok) {
      notify(setStatus, 'error', 'Could not convert', result.message);
      return;
    }
    setOpenLeadId(null);
    await load();
    notify(
      setStatus,
      result.warning ? 'error' : 'success',
      result.warning ? 'Partly done' : 'Converted',
      result.warning ??
        (result.jobNumber
          ? `${lead.name} is a customer now, with project ${result.jobNumber}.`
          : `${lead.name} is a customer now.`),
    );
    router.push({ pathname: '/crm/[id]', params: { id: result.customerId } });
  };

  // -------------------------------------------------------------------------
  // Render pieces
  // -------------------------------------------------------------------------

  const renderLead = (lead: Lead) => {
    const open = openLeadId === lead.id;
    const busy = convertingId === lead.id;
    return (
      <View key={lead.id} style={styles.leadCard}>
        <Pressable
          onPress={() => setOpenLeadId(open ? null : lead.id)}
          style={({ pressed }) => [styles.leadRow, pressed && styles.rowPressed]}>
          <View style={styles.leadBadge}>
            <Ionicons name="sparkles" size={15} color={colors.amberDeep} />
          </View>
          <View style={styles.leadBody}>
            <Text style={styles.leadName} numberOfLines={1}>
              {lead.name}
            </Text>
            <Text style={styles.leadMeta} numberOfLines={1}>
              {[
                lead.status,
                lead.source,
                lead.estimated_value != null ? money(lead.estimated_value) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </View>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
        </Pressable>
        {open ? (
          <View style={styles.leadSheet}>
            {lead.address ? <Text style={styles.leadDetail}>{lead.address}</Text> : null}
            {lead.phone ? <Text style={styles.leadDetail}>{lead.phone}</Text> : null}
            {lead.email ? <Text style={styles.leadDetail}>{lead.email}</Text> : null}
            {lead.notes ? <Text style={styles.leadDetail}>{lead.notes}</Text> : null}
            {isAdmin ? (
              <>
                <Pressable
                  onPress={() => void convert(lead, false)}
                  disabled={busy}
                  style={({ pressed }) => [styles.leadAction, pressed && styles.rowPressed]}>
                  {busy ? (
                    <ActivityIndicator size="small" color={colors.ocean} />
                  ) : (
                    <Ionicons name="person-add" size={15} color={colors.ocean} />
                  )}
                  <Text style={styles.leadActionText}>Add as customer</Text>
                </Pressable>
                <Pressable
                  onPress={() => void convert(lead, true)}
                  disabled={busy}
                  style={({ pressed }) => [styles.leadAction, pressed && styles.rowPressed]}>
                  <Ionicons name="hammer" size={15} color={colors.ocean} />
                  <Text style={styles.leadActionText}>Add as customer + open a project</Text>
                </Pressable>
                <Text style={styles.leadHint}>
                  The lead is marked won last, so a half-finished conversion leaves it in the funnel
                  where you will notice it.
                </Text>
              </>
            ) : (
              <Text style={styles.leadHint}>Only owners and operators can convert a lead.</Text>
            )}
          </View>
        ) : null}
      </View>
    );
  };

  const renderRow = (customer: Customer) => {
    const summary = summaries.get(customer.id);
    const unreadCount = unread.get(customer.id) ?? 0;
    const bits: string[] = [];
    if (summary) {
      if (summary.totalJobs > 0) {
        bits.push(summary.totalJobs === 1 ? '1 job' : `${summary.totalJobs} jobs`);
      }
      if (summary.balance > 0.005) bits.push(`${money(summary.balance)} due`);
      else if (summary.invoiced > 0.005) bits.push('paid up');
    }
    if (enrolled.has(customer.id)) bits.push('in portal');

    return (
      <Pressable
        onPress={() => router.push({ pathname: '/crm/[id]', params: { id: customer.id } })}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <CustomerAvatar
          customer={customer}
          size={44}
          url={avatarUrls.get(customer.id) ?? null}
          fallbackUrl={houseArt.get(customer.id) ?? null}
        />
        <View style={styles.rowBody}>
          <View style={styles.rowTitleLine}>
            <Text style={styles.rowName} numberOfLines={1}>
              {customer.name}
            </Text>
            {unreadCount > 0 ? <View style={styles.unreadDot} /> : null}
            {customer.archived_at ? (
              <View style={styles.archivedChip}>
                <Text style={styles.archivedChipText}>Archived</Text>
              </View>
            ) : null}
          </View>
          {bits.length > 0 ? (
            <Text style={styles.rowMeta} numberOfLines={1}>
              {bits.join(' · ')}
            </Text>
          ) : customer.address ? (
            <Text style={styles.rowMeta} numberOfLines={1}>
              {customer.address}
            </Text>
          ) : null}
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
      </Pressable>
    );
  };

  const header = (
    <View style={styles.headerArea}>
      <View style={styles.searchWrap}>
        <Ionicons name="search" size={18} color={colors.textMuted} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, phone or address"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          numberOfLines={1}
          accessibilityLabel="Search customers"
          style={styles.searchInput}
        />
        {search ? (
          <Pressable
            onPress={() => setSearch('')}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            style={({ pressed }) => (pressed ? styles.pressed : null)}>
            <Ionicons name="close-circle" size={20} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.controlRow}>
        <Chip
          label={`Sort: ${sortLabel} ▾`}
          icon="swap-vertical"
          onPress={() => setSortOpen(true)}
          style={styles.controlChip}
        />
        <Chip
          label={`Show: ${filterLabel} ▾`}
          icon="funnel"
          tone="ocean"
          selected={filter !== 'all'}
          onPress={() => setShowOpen(true)}
          style={styles.controlChip}
        />
      </View>

      {leads.length > 0 ? (
        <View style={styles.leadsSection}>
          <Text style={styles.sectionTitle}>
            Leads · {leads.length} not converted
          </Text>
          {leads.map(renderLead)}
        </View>
      ) : null}

      {!leadsOnly && listState === 'ok' ? (
        <Text style={styles.sectionTitle}>
          {filter === 'archived' ? 'Archived' : 'Customers'}
        </Text>
      ) : null}
    </View>
  );

  const footer = (
    <View style={styles.footerArea}>
      {isAdmin && listState === 'ok' && !leadsOnly ? (
        !showAddForm ? (
          <Pressable
            onPress={() => {
              setStatus(null);
              setShowAddForm(true);
            }}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
            <Ionicons name="add" size={18} color={colors.ink} />
            <Text style={styles.addButtonText}>Add customer</Text>
          </Pressable>
        ) : (
          <View style={styles.formCard}>
            <Text style={styles.formTitle}>New customer</Text>
            <Text style={styles.fieldLabel}>Name</Text>
            <TextInput
              value={addForm.name}
              onChangeText={(v) => setAddForm({ ...addForm, name: v })}
              placeholder="Full name"
              placeholderTextColor={colors.inkSoft}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>Phone (optional)</Text>
            <TextInput
              value={addForm.phone}
              onChangeText={(v) => setAddForm({ ...addForm, phone: v })}
              placeholder="e.g. (816) 555-0123"
              placeholderTextColor={colors.inkSoft}
              keyboardType="phone-pad"
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>Email (optional)</Text>
            <TextInput
              value={addForm.email}
              onChangeText={(v) => setAddForm({ ...addForm, email: v })}
              placeholder="e.g. name@example.com"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>Address (optional)</Text>
            <TextInput
              value={addForm.address}
              onChangeText={(v) => setAddForm({ ...addForm, address: v })}
              placeholder="Street, city, state"
              placeholderTextColor={colors.inkSoft}
              style={styles.input}
            />
            <Text style={styles.fieldLabel}>Notes (optional)</Text>
            <TextInput
              value={addForm.notes}
              onChangeText={(v) => setAddForm({ ...addForm, notes: v })}
              placeholder="Anything worth remembering"
              placeholderTextColor={colors.inkSoft}
              multiline
              style={[styles.input, styles.inputMultiline]}
            />
            <View style={styles.formButtons}>
              <Pressable
                onPress={() => {
                  setShowAddForm(false);
                  setAddForm(EMPTY_FORM);
                }}
                disabled={adding}
                style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                <Text style={styles.cancelButtonText}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void submitAdd()}
                disabled={adding}
                style={({ pressed }) => [
                  styles.saveButton,
                  (pressed || adding) && styles.pressed,
                ]}>
                {adding ? (
                  <ActivityIndicator color={colors.ink} size="small" />
                ) : (
                  <Text style={styles.saveButtonText}>Add customer</Text>
                )}
              </Pressable>
            </View>
          </View>
        )
      ) : null}

      {status ? (
        <Text
          style={[
            styles.statusText,
            status.kind === 'error' ? styles.statusError : styles.statusSuccess,
          ]}>
          {status.message}
        </Text>
      ) : null}
    </View>
  );

  if (auth === 'loading') {
    return (
      <View style={styles.screen}>
        <View style={styles.centerCard}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      </View>
    );
  }

  if (auth === 'out') {
    return (
      <View style={styles.screen}>
        <View style={styles.container}>
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="people" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to view customers</Text>
            <Text style={styles.promptText}>
              Customer contact details are only visible to signed-in crew members.
            </Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <>
      <FlatList
        style={styles.screen}
        data={visible}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => renderRow(item)}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
        }
        ListEmptyComponent={
          listState === 'loading' ? (
            <View style={styles.centerCard}>
              <ActivityIndicator color={colors.ocean} />
            </View>
          ) : listState === 'unavailable' ? (
            <View style={styles.centerCard}>
              <Text style={styles.promptText}>Customers are unavailable right now.</Text>
            </View>
          ) : leadsOnly ? null : (
            <View style={styles.centerCard}>
              <Ionicons name="people" size={22} color={colors.inkSoft} />
              <Text style={styles.promptText}>
                {search.trim()
                  ? 'No customers match that search'
                  : filter !== 'all'
                    ? 'No customers match that filter'
                    : isAdmin
                      ? 'No customers yet — add the first one'
                      : 'No customers yet'}
              </Text>
            </View>
          )
        }
      />

      {/*
        The sheets are siblings of the list, not children of its header:
        `ListHeaderComponent` re-renders on every data change, and a Modal
        that re-mounts mid-scroll loses the wheel's position.
      */}
      <WheelPickerSheet
        visible={sortOpen}
        title="Sort by"
        options={sortOptions}
        value={sort}
        onChange={setSort}
        onClose={() => setSortOpen(false)}
      />
      <WheelPickerSheet
        visible={showOpen}
        title="Show"
        options={filterOptions}
        value={filter}
        onChange={setFilter}
        onClose={() => setShowOpen(false)}
      />
    </>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: colors.cream,
  },
  container: {
    padding: spacing.lg,
    paddingBottom: spacing.xxl,
  },
  headerArea: {
    gap: spacing.md,
    marginBottom: spacing.sm,
  },
  footerArea: {
    gap: spacing.md,
    marginTop: spacing.md,
  },
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
  promptTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '800',
    textAlign: 'center',
  },
  promptText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  /**
   * The search field, rebuilt 2026-08-22. It was 34pt tall with a 15pt bold
   * label and a placeholder longer than the box, so on a phone the hint read
   * "Search name, phone, ema…" and the typed value clipped its descenders.
   * Full width, 48 tall, one weight lighter, shorter hint.
   */
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  searchInput: {
    flex: 1,
    // A flex child defaults to `min-width: auto` on the web, which is what
    // let a long value push the clear button off the pill instead of
    // scrolling inside it.
    minWidth: 0,
    minHeight: 44,
    paddingVertical: spacing.sm,
    paddingHorizontal: 0,
    color: colors.textPrimary,
    fontFamily: typography.body.fontFamily,
    // typography.body is 15; 16 is the floor below which mobile Safari zooms
    // the whole page when the field takes focus. No `lineHeight` — on a web
    // <input> it clips descenders rather than centring the text.
    fontSize: 16,
  },
  controlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.sm,
  },
  controlChip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  sectionTitle: {
    marginTop: spacing.sm,
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
  },
  leadsSection: { gap: spacing.xs },
  leadCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  leadRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  leadBadge: {
    width: 30,
    height: 30,
    borderRadius: radii.sm,
    backgroundColor: colors.amberSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  leadBody: { flex: 1, gap: 2 },
  leadName: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  leadMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  leadSheet: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
    paddingTop: spacing.sm,
  },
  leadDetail: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  leadAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
  },
  leadActionText: { color: colors.ocean, fontSize: 14, fontWeight: '800' },
  leadHint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    ...shadows.card,
  },
  separator: { height: spacing.sm },
  rowPressed: { backgroundColor: colors.skySoft },
  rowBody: { flex: 1, gap: 2 },
  rowTitleLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowName: { color: colors.ink, fontSize: 16, fontWeight: '800', flexShrink: 1 },
  rowMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  unreadDot: {
    width: 9,
    height: 9,
    borderRadius: 999,
    backgroundColor: colors.coral,
  },
  archivedChip: {
    backgroundColor: colors.slateSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  archivedChipText: { color: colors.slateDeep, fontSize: 10, fontWeight: '800' },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  formTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.tan,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
    backgroundColor: colors.cream,
  },
  inputMultiline: { minHeight: 64, textAlignVertical: 'top' },
  formButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  cancelButton: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.pill,
  },
  cancelButtonText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    alignSelf: 'flex-start',
  },
  addButtonText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.7 },
  statusText: { fontSize: 13, fontWeight: '600', textAlign: 'center' },
  statusError: { color: colors.danger },
  statusSuccess: { color: colors.ocean },
});
