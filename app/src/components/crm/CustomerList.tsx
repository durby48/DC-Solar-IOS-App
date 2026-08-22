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
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { fetchEnrolledCustomerIds } from '@/lib/account';
import {
  addCustomer,
  convertLeadToCustomer,
  fetchCrmCustomers,
  fetchCustomerAvatarUrls,
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

type SortKey = 'name' | 'recent' | 'balance' | 'jobs';
type FilterKey = 'openJobs' | 'balance' | 'inPortal' | 'notInPortal' | 'leads' | 'archived';

const SORTS: { key: SortKey; label: string; needsMetrics: boolean }[] = [
  { key: 'name', label: 'Name', needsMetrics: false },
  { key: 'recent', label: 'Recent', needsMetrics: true },
  { key: 'balance', label: 'Balance', needsMetrics: true },
  { key: 'jobs', label: 'Open jobs', needsMetrics: true },
];

const FILTERS: { key: FilterKey; label: string; needsMetrics: boolean }[] = [
  { key: 'openJobs', label: 'Open jobs', needsMetrics: true },
  { key: 'balance', label: 'Balance due', needsMetrics: true },
  { key: 'inPortal', label: 'In portal', needsMetrics: false },
  { key: 'notInPortal', label: 'Not in portal', needsMetrics: false },
  { key: 'leads', label: 'Leads', needsMetrics: false },
  { key: 'archived', label: 'Archived', needsMetrics: false },
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

export function CustomerList() {
  const router = useRouter();
  const auth = useAuthState();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [listState, setListState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [summaries, setSummaries] = useState<Map<string, CustomerSummary>>(new Map());
  const [avatarUrls, setAvatarUrls] = useState<Map<string, string>>(new Map());
  const [enrolled, setEnrolled] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState<Map<string, number>>(new Map());
  const [leads, setLeads] = useState<Lead[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortKey>('name');
  const [filters, setFilters] = useState<Set<FilterKey>>(new Set());

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
   * Archived customers are fetched too and hidden client-side, so flipping the
   * Archived chip (which is how you find the row behind a duplicate-name
   * error) never costs a round trip.
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
      setListState('unavailable');
      return;
    }

    const rows = customersRes.customers;
    setCustomers(rows);
    setListState('ok');

    const [summaryMap, urlMap] = await Promise.all([
      fetchCustomerSummaries(rows.map((c) => c.id)),
      fetchCustomerAvatarUrls(rows),
    ]);
    setSummaries(summaryMap);
    setAvatarUrls(urlMap);
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
   * not "loading failed". Sort and filter chips that depend on it hide.
   */
  const hasMetrics = summaries.size > 0;
  const leadsOnly = filters.has('leads');

  const toggleFilter = (key: FilterKey) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // "In portal" and "Not in portal" cancel each other out; picking one
      // clears the other rather than showing an empty list.
      if (key === 'inPortal') next.delete('notInPortal');
      if (key === 'notInPortal') next.delete('inPortal');
      return next;
    });
  };

  const visible = useMemo(() => {
    if (leadsOnly) return [];
    const wantArchived = filters.has('archived');
    let rows = customers.filter((c) => (wantArchived ? c.archived_at != null : c.archived_at == null));

    if (filters.has('openJobs')) {
      rows = rows.filter((c) => (summaries.get(c.id)?.openJobs ?? 0) > 0);
    }
    if (filters.has('balance')) {
      rows = rows.filter((c) => (summaries.get(c.id)?.balance ?? 0) > 0.005);
    }
    if (filters.has('inPortal')) rows = rows.filter((c) => enrolled.has(c.id));
    if (filters.has('notInPortal')) rows = rows.filter((c) => !enrolled.has(c.id));

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
  }, [customers, summaries, enrolled, filters, search, sort, leadsOnly]);

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
          size={38}
          url={avatarUrls.get(customer.id) ?? null}
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
        <Ionicons name="search" size={16} color={colors.inkSoft} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, phone, email or address"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
        {search ? (
          <Pressable onPress={() => setSearch('')} hitSlop={8}>
            <Ionicons name="close-circle" size={16} color={colors.inkSoft} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.chipRow}>
        <Text style={styles.chipRowLabel}>Sort</Text>
        {SORTS.filter((s) => !s.needsMetrics || hasMetrics).map((option) => {
          const active = sort === option.key;
          return (
            <Pressable
              key={option.key}
              onPress={() => setSort(option.key)}
              style={({ pressed }) => [
                styles.chip,
                active && styles.chipActive,
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.chipRow}>
        <Text style={styles.chipRowLabel}>Show</Text>
        {FILTERS.filter((f) => !f.needsMetrics || hasMetrics).map((option) => {
          const active = filters.has(option.key);
          return (
            <Pressable
              key={option.key}
              onPress={() => toggleFilter(option.key)}
              style={({ pressed }) => [
                styles.chip,
                active && styles.chipActive,
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>{option.label}</Text>
            </Pressable>
          );
        })}
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
          {filters.has('archived') ? 'Archived' : 'Customers'} · {visible.length}
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
                : filters.size > 0
                  ? 'No customers match those filters'
                  : isAdmin
                    ? 'No customers yet — add the first one'
                    : 'No customers yet'}
            </Text>
          </View>
        )
      }
    />
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
    gap: spacing.sm,
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
  searchInput: {
    flex: 1,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
    padding: 0,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
  },
  chipRowLabel: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginRight: 2,
  },
  chip: {
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  chipActive: {
    backgroundColor: colors.ocean,
    borderColor: colors.ocean,
  },
  chipText: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  chipTextActive: { color: colors.white },
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
