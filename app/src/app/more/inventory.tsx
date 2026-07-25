import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
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
  const [saving, setSaving] = useState(false);

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
        notify(setStatus, 'error', 'Partly saved', result.stockingError);
      } else {
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
        <Text style={styles.fieldLabel}>
          {meta.signed ? 'Change (+/-)' : `Quantity (${item.unit})`}
        </Text>
        <TextInput
          value={qtyText}
          onChangeText={setQtyText}
          placeholder={meta.signed ? 'e.g. -2 or 5' : 'e.g. 3'}
          placeholderTextColor={colors.inkSoft}
          keyboardType={meta.signed ? 'numbers-and-punctuation' : 'decimal-pad'}
          style={styles.input}
        />
        {action === 'use' && jobs.length > 0 ? (
          <>
            <Text style={styles.fieldLabel}>Job (optional)</Text>
            <View style={styles.chipRow}>
              <Pressable
                onPress={() => setActionJobId(null)}
                style={[styles.chip, actionJobId === null && styles.chipSelected]}>
                <Text style={[styles.chipText, actionJobId === null && styles.chipTextSelected]}>
                  None
                </Text>
              </Pressable>
              {jobs.map((job) => (
                <Pressable
                  key={job.id}
                  onPress={() => setActionJobId(job.id)}
                  style={[styles.chip, actionJobId === job.id && styles.chipSelected]}>
                  <Text
                    style={[styles.chipText, actionJobId === job.id && styles.chipTextSelected]}>
                    {job.job_number ? `Job ${job.job_number}` : job.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}
        <View style={styles.formButtons}>
          <Pressable
            onPress={resetAction}
            disabled={saving}
            style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => saveAction(item)}
            disabled={saving}
            style={({ pressed }) => [styles.saveButton, (pressed || saving) && styles.pressed]}>
            {saving ? (
              <ActivityIndicator color={colors.ink} size="small" />
            ) : (
              <Text style={styles.saveButtonText}>{meta.label}</Text>
            )}
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Inventory' }} />
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        {auth.state === 'loading' ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : auth.state === 'out' ? (
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="cube" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to view inventory</Text>
            <Text style={styles.promptText}>
              Materials and stock levels are only visible to signed-in crew members.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Materials</Text>
            {itemsState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : itemsState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>Inventory is unavailable right now.</Text>
              </View>
            ) : items.length === 0 ? (
              <View style={styles.centerCard}>
                <Ionicons name="cube" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>
                  {isAdmin ? 'No materials yet — add your first item' : 'No materials yet'}
                </Text>
              </View>
            ) : (
              <View style={styles.listCard}>
                {items.map((item, index) => {
                  const expanded = expandedId === item.id;
                  return (
                    <View key={item.id} style={index > 0 ? styles.rowBorderTop : null}>
                      <Pressable
                        onPress={() => toggleExpand(item.id)}
                        style={({ pressed }) => [styles.itemRow, pressed && styles.rowPressed]}>
                        <View style={styles.itemBody}>
                          <Text style={styles.itemName}>{item.name}</Text>
                          {item.sku ? <Text style={styles.itemSku}>SKU {item.sku}</Text> : null}
                        </View>
                        {isLow(item) ? (
                          <View style={styles.lowPill}>
                            <Ionicons name="warning" size={11} color={colors.danger} />
                            <Text style={styles.lowPillText}>Low</Text>
                          </View>
                        ) : null}
                        <Text style={styles.itemQty}>
                          {formatQty(item.qty_on_hand)} {item.unit}
                        </Text>
                        <Ionicons
                          name={expanded ? 'chevron-up' : 'chevron-down'}
                          size={16}
                          color={colors.inkSoft}
                        />
                      </Pressable>
                      {expanded ? (
                        <View style={styles.expandArea}>
                          <View style={styles.chipRow}>
                            {(Object.keys(ACTION_META) as ActionKind[])
                              .filter((kind) => isAdmin || !ACTION_META[kind].adminOnly)
                              .map((kind) => (
                                <Pressable
                                  key={kind}
                                  onPress={() => {
                                    setStatus(null);
                                    setQtyText('');
                                    setActionJobId(null);
                                    setAction((prev) => (prev === kind ? null : kind));
                                  }}
                                  style={[styles.chip, action === kind && styles.chipSelected]}>
                                  <Text
                                    style={[
                                      styles.chipText,
                                      action === kind && styles.chipTextSelected,
                                    ]}>
                                    {ACTION_META[kind].label}
                                  </Text>
                                </Pressable>
                              ))}
                          </View>
                          {renderActionForm(item)}
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )}

            {isAdmin && itemsState !== 'loading' ? (
              !showAddForm ? (
                <Pressable
                  onPress={() => {
                    setStatus(null);
                    setShowAddForm(true);
                  }}
                  style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
                  <Ionicons name="add" size={18} color={colors.ink} />
                  <Text style={styles.addButtonText}>Add item</Text>
                </Pressable>
              ) : (
                <View style={styles.formCard}>
                  <Text style={styles.formTitle}>New item</Text>
                  <Text style={styles.fieldLabel}>Name</Text>
                  <TextInput
                    value={newName}
                    onChangeText={setNewName}
                    placeholder="e.g. MC4 connectors"
                    placeholderTextColor={colors.inkSoft}
                    style={styles.input}
                  />
                  <Text style={styles.fieldLabel}>SKU (optional)</Text>
                  <TextInput
                    value={newSku}
                    onChangeText={setNewSku}
                    placeholder="e.g. MC4-100"
                    placeholderTextColor={colors.inkSoft}
                    autoCapitalize="characters"
                    style={styles.input}
                  />
                  <Text style={styles.fieldLabel}>Unit</Text>
                  <TextInput
                    value={newUnit}
                    onChangeText={setNewUnit}
                    placeholder="each"
                    placeholderTextColor={colors.inkSoft}
                    autoCapitalize="none"
                    style={styles.input}
                  />
                  <Text style={styles.fieldLabel}>Starting qty</Text>
                  <TextInput
                    value={newQty}
                    onChangeText={setNewQty}
                    placeholder="0"
                    placeholderTextColor={colors.inkSoft}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                  <Text style={styles.fieldLabel}>Low-stock alert below (optional)</Text>
                  <TextInput
                    value={newMinQty}
                    onChangeText={setNewMinQty}
                    placeholder="e.g. 10"
                    placeholderTextColor={colors.inkSoft}
                    keyboardType="decimal-pad"
                    style={styles.input}
                  />
                  <View style={styles.formButtons}>
                    <Pressable
                      onPress={resetAddForm}
                      disabled={adding}
                      style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={submitAddItem}
                      disabled={adding}
                      style={({ pressed }) => [
                        styles.saveButton,
                        (pressed || adding) && styles.pressed,
                      ]}>
                      {adding ? (
                        <ActivityIndicator color={colors.ink} size="small" />
                      ) : (
                        <Text style={styles.saveButtonText}>Add item</Text>
                      )}
                    </Pressable>
                  </View>
                </View>
              )
            ) : null}
          </>
        )}

        {status ? (
          <Text
            style={[
              styles.statusText,
              status.kind === 'error' ? styles.statusError : styles.statusSuccess,
            ]}>
            {status.message}
          </Text>
        ) : null}
      </ScrollView>
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
    gap: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 18,
    fontWeight: '700',
    marginTop: spacing.sm,
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
  listCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.md,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  itemBody: {
    flex: 1,
    gap: 2,
  },
  itemName: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '700',
  },
  itemSku: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  itemQty: {
    color: colors.ocean,
    fontSize: 15,
    fontWeight: '800',
  },
  lowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  lowPillText: {
    color: colors.danger,
    fontSize: 11,
    fontWeight: '800',
  },
  expandArea: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
  },
  actionForm: {
    gap: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 2,
    backgroundColor: colors.cream,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  chipSelected: {
    backgroundColor: colors.sun,
    borderColor: colors.sun,
  },
  chipText: {
    color: colors.inkSoft,
    fontSize: 13,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: colors.ink,
  },
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
  cancelButtonText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
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
  addButtonText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '800',
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  formTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  pressed: {
    opacity: 0.7,
  },
  statusText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusError: {
    color: colors.danger,
  },
  statusSuccess: {
    color: colors.ocean,
  },
});
