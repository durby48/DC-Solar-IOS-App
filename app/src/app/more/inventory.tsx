import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, StyleSheet, TextInput, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  Chip,
  EmptyState,
  FadeInUp,
  Pill,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
import {
  addInventoryItem,
  addInventoryTransaction,
  fetchInventoryItems,
  fetchInventoryJobs,
  type InventoryItem,
  type InventoryJobOption,
  type TransactionReason,
} from '@/lib/inventory';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

type ActionKind = 'use' | 'return' | 'restock' | 'adjust';

const ACTION_META: Record<
  ActionKind,
  { label: string; reason: TransactionReason; adminOnly: boolean; signed: boolean }
> = {
  use: { label: 'Use on job', reason: 'used_on_job', adminOnly: false, signed: false },
  return: { label: 'Return', reason: 'return', adminOnly: false, signed: false },
  restock: { label: 'Restock', reason: 'restock', adminOnly: true, signed: false },
  adjust: { label: 'Adjust', reason: 'adjustment', adminOnly: true, signed: true },
};

function formatQty(qty: number): string {
  return Number.isInteger(qty) ? `${qty}` : qty.toFixed(2).replace(/\.?0+$/, '');
}

/** Session email + loading state (role.ts returns null both while loading and signed out). */
function useAuthEmail(): { state: 'loading' | 'out' | 'in'; email: string | null } {
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'out' | 'in'>('loading');
  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      const e = data.session?.user?.email ?? null;
      setEmail(e);
      setState(e ? 'in' : 'out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      const e = session?.user?.email ?? null;
      setEmail(e);
      setState(e ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);
  return { state, email };
}

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

export default function InventoryScreen() {
  const auth = useAuthEmail();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [itemsState, setItemsState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [jobs, setJobs] = useState<InventoryJobOption[]>([]);

  // Expanded item + inline action form
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionKind | null>(null);
  const [qtyText, setQtyText] = useState('');
  const [actionJobId, setActionJobId] = useState<string | null>(null);
  const [jobSearch, setJobSearch] = useState('');
  const [saving, setSaving] = useState(false);

  const filteredJobs = useMemo(() => {
    const q = jobSearch.trim().toLowerCase();
    if (!q) return jobs;
    return jobs.filter((job) =>
      [job.job_number, job.name, job.customerName, job.address].some((field) =>
        field?.toLowerCase().includes(q),
      ),
    );
  }, [jobs, jobSearch]);

  // Admin add-item form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newSku, setNewSku] = useState('');
  const [newUnit, setNewUnit] = useState('each');
  const [newQty, setNewQty] = useState('');
  const [newMinQty, setNewMinQty] = useState('');
  const [adding, setAdding] = useState(false);

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const loadItems = useCallback(async () => {
    const result = await fetchInventoryItems();
    if (result.status === 'ok') {
      setItems(result.items);
      setItemsState('ok');
    } else {
      setItems([]);
      setItemsState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (auth.state !== 'in') return;
    loadItems();
    fetchInventoryJobs().then(setJobs);
  }, [auth.state, loadItems]);

  const resetAction = () => {
    setAction(null);
    setQtyText('');
    setActionJobId(null);
    setJobSearch('');
    setSaving(false);
  };

  const toggleExpand = (itemId: string) => {
    setStatus(null);
    resetAction();
    setExpandedId((prev) => (prev === itemId ? null : itemId));
  };

  const saveAction = async (item: InventoryItem) => {
    if (!auth.email || !action) return;
    setStatus(null);
    const meta = ACTION_META[action];
    const raw = qtyText.trim();
    const qty = Number(raw);
    if (!raw || !Number.isFinite(qty) || qty === 0 || (!meta.signed && qty < 0)) {
      notify(
        setStatus,
        'error',
        'Check the quantity',
        meta.signed ? 'Enter a non-zero amount, e.g. 3 or -2.' : 'Enter an amount above zero.',
      );
      return;
    }
    const delta = action === 'use' ? -Math.abs(qty) : action === 'adjust' ? qty : Math.abs(qty);
    setSaving(true);
    const result = await addInventoryTransaction({
      itemId: item.id,
      delta,
      reason: meta.reason,
      jobId: action === 'use' ? actionJobId : null,
      employee: auth.email,
    });
    if (result.ok) {
      await loadItems(); // DB trigger applied the delta — refetch for the source of truth.
      resetAction();
      setExpandedId(null);
      haptics.success();
      notify(setStatus, 'success', 'Saved', `${item.name} updated.`);
    } else {
      setSaving(false);
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  const resetAddForm = () => {
    setShowAddForm(false);
    setNewName('');
    setNewSku('');
    setNewUnit('each');
    setNewQty('');
    setNewMinQty('');
    setAdding(false);
  };

  const submitAddItem = async () => {
    if (!auth.email) return;
    setStatus(null);
    if (!newName.trim()) {
      notify(setStatus, 'error', 'Missing name', 'Give the item a name.');
      return;
    }
    const startingQty = newQty.trim() ? Number(newQty) : 0;
    if (!Number.isFinite(startingQty) || startingQty < 0) {
      notify(setStatus, 'error', 'Check starting qty', 'Enter zero or a positive number.');
      return;
    }
    const minQty = newMinQty.trim() ? Number(newMinQty) : null;
    if (minQty !== null && (!Number.isFinite(minQty) || minQty < 0)) {
      notify(setStatus, 'error', 'Check min qty', 'Enter zero or a positive number.');
      return;
    }
    setAdding(true);
    const result = await addInventoryItem({
      name: newName.trim(),
      sku: newSku.trim() || null,
      unit: newUnit.trim() || 'each',
      minQty,
      startingQty,
      employee: auth.email,
    });
    if (result.ok) {
      await loadItems();
      resetAddForm();
      if (result.stockingError) {
        haptics.warn();
        notify(setStatus, 'error', 'Partly saved', result.stockingError);
      } else {
        haptics.success();
        notify(setStatus, 'success', 'Item added', `${result.item.name} is now tracked.`);
      }
    } else {
      setAdding(false);
      notify(setStatus, 'error', 'Could not add item', result.message);
    }
  };

  const isLow = (item: InventoryItem) => item.min_qty != null && item.qty_on_hand < item.min_qty;

  const renderActionForm = (item: InventoryItem) => {
    if (!action) return null;
    const meta = ACTION_META[action];
    return (
      <View style={styles.actionForm}>
        <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
          {meta.signed ? 'Change (+/-)' : `Quantity (${item.unit})`}
        </AppText>
        <TextInput
          value={qtyText}
          onChangeText={setQtyText}
          placeholder={meta.signed ? 'e.g. -2 or 5' : 'e.g. 3'}
          placeholderTextColor={colors.textMuted}
          keyboardType={meta.signed ? 'numbers-and-punctuation' : 'decimal-pad'}
          style={styles.input}
        />
        {action === 'use' && jobs.length > 0 ? (
          <>
            <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
              Job (optional)
            </AppText>
            {jobs.length > 6 ? (
              <TextInput
                value={jobSearch}
                onChangeText={setJobSearch}
                placeholder="Search job, customer or address"
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            ) : null}
            <View style={styles.chipRow}>
              <Chip
                label="None"
                tone="sun"
                selected={actionJobId === null}
                onPress={() => setActionJobId(null)}
              />
              {filteredJobs.map((job) => (
                <Chip
                  key={job.id}
                  label={job.job_number ? `Job ${job.job_number}` : job.name}
                  tone="sun"
                  selected={actionJobId === job.id}
                  onPress={() => setActionJobId(job.id)}
                />
              ))}
              {filteredJobs.length === 0 ? (
                <AppText variant="caption" color={colors.textMuted}>
                  No jobs match &quot;{jobSearch.trim()}&quot;.
                </AppText>
              ) : null}
            </View>
          </>
        ) : null}
        <View style={styles.formButtons}>
          <Button
            label="Cancel"
            variant="ghost"
            size="sm"
            disabled={saving}
            onPress={resetAction}
          />
          <Button
            label={meta.label}
            size="sm"
            loading={saving}
            onPress={() => saveAction(item)}
          />
        </View>
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Inventory' }} />
      <Screen edges={[]}>
        {auth.state === 'loading' ? (
          <SkeletonList count={4} height={60} />
        ) : auth.state === 'out' ? (
          <Card>
            <EmptyState
              icon="cube"
              title="Sign in to view inventory"
              body="Materials and stock levels are only visible to signed-in crew members."
            />
          </Card>
        ) : (
          <>
            <SectionHeader title="Materials" icon="cube-outline" style={styles.sectionHeader} />
            {itemsState === 'loading' ? (
              <SkeletonList count={5} height={60} />
            ) : itemsState === 'unavailable' ? (
              <Card>
                <EmptyState
                  icon="cloud-offline-outline"
                  title="Inventory is unavailable right now."
                  body="Stock levels could not be loaded. Try again once you are back on a signal."
                />
              </Card>
            ) : items.length === 0 ? (
              <Card>
                <EmptyState
                  icon="cube"
                  title={isAdmin ? 'No materials yet — add your first item' : 'No materials yet'}
                  body="Anything the office tracks — connectors, rail, breakers — shows up here with what's on hand."
                />
              </Card>
            ) : (
              <Card padded={false}>
                {items.map((item, index) => {
                  const expanded = expandedId === item.id;
                  return (
                    <FadeInUp key={item.id} index={index}>
                      <View style={index > 0 ? styles.rowBorderTop : null}>
                        <AnimatedPressable
                          onPress={() => toggleExpand(item.id)}
                          haptic="tapLight"
                          scaleTo={0.99}
                          accessibilityRole="button"
                          accessibilityState={{ expanded }}
                          accessibilityLabel={item.name}
                          style={({ pressed }) => [
                            styles.itemRow,
                            pressed && styles.rowPressed,
                          ]}>
                          <View style={styles.itemBody}>
                            <AppText variant="bodyStrong">{item.name}</AppText>
                            {item.sku ? (
                              <AppText variant="caption" color={colors.textMuted}>
                                SKU {item.sku}
                              </AppText>
                            ) : null}
                          </View>
                          {isLow(item) ? (
                            <Pill label="Low" bg={colors.coralSoft} fg={colors.coralDeep} />
                          ) : null}
                          <AppText variant="bodyStrong" color={colors.accentPrimary}>
                            {formatQty(item.qty_on_hand)} {item.unit}
                          </AppText>
                          <Ionicons
                            name={expanded ? 'chevron-up' : 'chevron-down'}
                            size={16}
                            color={colors.textMuted}
                          />
                        </AnimatedPressable>
                        {expanded ? (
                          <View style={styles.expandArea}>
                            <View style={styles.chipRow}>
                              {(Object.keys(ACTION_META) as ActionKind[])
                                .filter((kind) => isAdmin || !ACTION_META[kind].adminOnly)
                                .map((kind) => (
                                  <Chip
                                    key={kind}
                                    label={ACTION_META[kind].label}
                                    tone="olive"
                                    selected={action === kind}
                                    onPress={() => {
                                      setStatus(null);
                                      setQtyText('');
                                      setActionJobId(null);
                                      setAction((prev) => (prev === kind ? null : kind));
                                    }}
                                  />
                                ))}
                            </View>
                            {renderActionForm(item)}
                          </View>
                        ) : null}
                      </View>
                    </FadeInUp>
                  );
                })}
              </Card>
            )}

            {isAdmin && itemsState !== 'loading' ? (
              !showAddForm ? (
                <Button
                  label="Add item"
                  icon="add"
                  variant="secondary"
                  onPress={() => {
                    setStatus(null);
                    setShowAddForm(true);
                  }}
                  style={styles.addButton}
                />
              ) : (
                <Card style={styles.formCard}>
                  <AppText variant="heading">New item</AppText>
                  <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                    Name
                  </AppText>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    placeholder="e.g. MC4 connectors"
                    placeholderTextColor={colors.textMuted}
                    style={styles.input}
                  />
                  <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                    SKU (optional)
                  </AppText>
                  <TextInput
                    value={newSku}
                    onChangeText={setNewSku}
                    placeholder="e.g. MC4-100"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="characters"
                    style={styles.input}
                  />
                  <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                    Unit
                  </AppText>
                  <TextInput
                    value={newUnit}
                    onChangeText={setNewUnit}
                    placeholder="each"
                    placeholderTextColor={colors.textMuted}
                    autoCapitalize="none"
                    style={styles.input}
                  />
                  <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                    Starting qty
                  </AppText>
                  <TextInput
                    value={newQty}
                    onChangeText={setNewQty}
                    placeholder="0"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                  <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
                    Low-stock alert below (optional)
                  </AppText>
                  <TextInput
                    value={newMinQty}
                    onChangeText={setNewMinQty}
                    placeholder="e.g. 10"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                  <View style={styles.formButtons}>
                    <Button
                      label="Cancel"
                      variant="ghost"
                      size="sm"
                      disabled={adding}
                      onPress={resetAddForm}
                    />
                    <Button
                      label="Add item"
                      size="sm"
                      loading={adding}
                      onPress={submitAddItem}
                    />
                  </View>
                </Card>
              )
            ) : null}
          </>
        )}

        {status ? (
          <AppText
            variant="caption"
            align="center"
            color={status.kind === 'error' ? colors.danger : colors.success}>
            {status.message}
          </AppText>
        ) : null}
      </Screen>
    </>
  );
}

const styles = StyleSheet.create({
  sectionHeader: {
    marginTop: spacing.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  rowPressed: {
    backgroundColor: colors.oliveTint,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  itemBody: {
    flex: 1,
    gap: 2,
  },
  expandArea: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    backgroundColor: colors.surface,
  },
  actionForm: {
    gap: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  fieldLabel: {
    marginTop: spacing.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
    backgroundColor: colors.surfaceSunk,
  },
  formButtons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  addButton: {
    alignSelf: 'flex-start',
  },
  formCard: {
    gap: spacing.xs,
  },
});
