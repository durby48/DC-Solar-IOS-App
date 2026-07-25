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
  addChecklistItem,
  deactivateChecklistItem,
  fetchChecklistItems,
  fetchRecentRuns,
  fetchVehicles,
  submitChecklistRun,
  type ChecklistItem,
  type ChecklistRun,
  type Vehicle,
} from '@/lib/checklist';
import { formatShortDate, todayISO } from '@/lib/dates';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

// Danger tint for "missing" rows, derived from the theme danger color.
const DANGER_TINT = `${colors.danger}1A`;

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

const VEHICLE_ICONS: Record<Vehicle['kind'], keyof typeof Ionicons.glyphMap> = {
  truck: 'car',
  van: 'bus',
  other: 'cube',
};

export default function ChecklistScreen() {
  const auth = useAuthEmail();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehiclesState, setVehiclesState] = useState<'loading' | 'ok'>('loading');
  const [vehicleId, setVehicleId] = useState<string | null>(null);

  const [itemsState, setItemsState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [results, setResults] = useState<Record<string, boolean>>({});
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [runs, setRuns] = useState<ChecklistRun[]>([]);

  // Admin manage-list mode
  const [manageMode, setManageMode] = useState(false);
  const [newItemName, setNewItemName] = useState('');
  const [addingItem, setAddingItem] = useState(false);

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  useEffect(() => {
    if (auth.state !== 'in') return;
    fetchVehicles().then((list) => {
      setVehicles(list);
      setVehiclesState('ok');
      setVehicleId((prev) => prev ?? list[0]?.id ?? null);
    });
  }, [auth.state]);

  const loadItems = useCallback(async (vId: string) => {
    setItemsState('loading');
    const result = await fetchChecklistItems(vId);
    if (result.status === 'ok') {
      setItems(result.items);
      setItemsState('ok');
      // Everything starts as "present"; crew taps what's missing.
      const fresh: Record<string, boolean> = {};
      for (const item of result.items) fresh[item.id] = true;
      setResults(fresh);
    } else {
      setItems([]);
      setResults({});
      setItemsState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (auth.state !== 'in' || !vehicleId) return;
    loadItems(vehicleId);
    fetchRecentRuns(vehicleId).then(setRuns);
    setNote('');
    setManageMode(false);
    setStatus(null);
  }, [auth.state, vehicleId, loadItems]);

  const missingCount = items.reduce(
    (count, item) => count + (results[item.id] === false ? 1 : 0),
    0,
  );

  const toggleItem = (itemId: string) => {
    setResults((prev) => ({ ...prev, [itemId]: prev[itemId] === false }));
  };

  const submitCheck = async () => {
    if (!auth.email || !vehicleId || items.length === 0) return;
    setStatus(null);
    setSubmitting(true);
    const resultMap: Record<string, boolean> = {};
    for (const item of items) resultMap[item.id] = results[item.id] !== false;
    const result = await submitChecklistRun({
      vehicleId,
      employee: auth.email,
      runDate: todayISO(),
      results: resultMap,
      missingCount,
      note: note.trim() || null,
    });
    setSubmitting(false);
    if (result.ok) {
      setRuns((prev) => [result.run, ...prev].slice(0, 5));
      setResults(() => {
        const fresh: Record<string, boolean> = {};
        for (const item of items) fresh[item.id] = true;
        return fresh;
      });
      setNote('');
      notify(
        setStatus,
        'success',
        'Check submitted',
        missingCount === 0
          ? 'Everything is on board. Nice.'
          : `${missingCount} item${missingCount === 1 ? '' : 's'} marked missing.`,
      );
    } else {
      notify(setStatus, 'error', 'Could not submit', result.message);
    }
  };

  const submitNewItem = async () => {
    if (!vehicleId) return;
    setStatus(null);
    const name = newItemName.trim();
    if (!name) {
      notify(setStatus, 'error', 'Missing name', 'Type the tool or item name first.');
      return;
    }
    setAddingItem(true);
    const nextSortOrder = items.reduce((max, item) => Math.max(max, item.sort_order), 0) + 1;
    const result = await addChecklistItem({ vehicleId, name, sortOrder: nextSortOrder });
    setAddingItem(false);
    if (result.ok) {
      setItems((prev) => [...prev, result.item]);
      setResults((prev) => ({ ...prev, [result.item.id]: true }));
      setItemsState('ok');
      setNewItemName('');
    } else {
      notify(setStatus, 'error', 'Could not add item', result.message);
    }
  };

  const removeItem = async (item: ChecklistItem) => {
    const ok = await deactivateChecklistItem(item.id);
    if (ok) {
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setResults((prev) => {
        const next = { ...prev };
        delete next[item.id];
        return next;
      });
    } else {
      notify(setStatus, 'error', 'Could not remove', `${item.name} was not removed.`);
    }
  };

  const confirmRemoveItem = (item: ChecklistItem) => {
    setStatus(null);
    if (Platform.OS === 'web') {
      removeItem(item);
      return;
    }
    Alert.alert('Remove item', `Remove "${item.name}" from this checklist?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void removeItem(item) },
    ]);
  };

  const employeeLabel = (email: string) => email.split('@')[0] || email;

  const showManageArea = isAdmin && (manageMode || (itemsState === 'ok' && items.length === 0));

  return (
    <>
      <Stack.Screen options={{ title: 'Truck Checklist' }} />
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
              <Ionicons name="clipboard" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to run a vehicle check</Text>
            <Text style={styles.promptText}>
              Daily tool checks are recorded per crew member, so sign in first.
            </Text>
          </View>
        ) : vehiclesState === 'loading' ? (
          <View style={styles.centerCard}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : vehicles.length === 0 ? (
          <View style={styles.centerCard}>
            <Ionicons name="car" size={22} color={colors.inkSoft} />
            <Text style={styles.promptText}>No vehicles are set up yet.</Text>
          </View>
        ) : (
          <>
            <View style={styles.chipRow}>
              {vehicles.map((vehicle) => (
                <Pressable
                  key={vehicle.id}
                  onPress={() => setVehicleId(vehicle.id)}
                  style={[styles.vehicleChip, vehicleId === vehicle.id && styles.chipSelected]}>
                  <Ionicons
                    name={VEHICLE_ICONS[vehicle.kind] ?? 'cube'}
                    size={15}
                    color={vehicleId === vehicle.id ? colors.ink : colors.inkSoft}
                  />
                  <Text
                    style={[
                      styles.chipText,
                      vehicleId === vehicle.id && styles.chipTextSelected,
                    ]}>
                    {vehicle.name}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={styles.checkHeader}>
              <Text style={styles.sectionTitle}>Today&apos;s check</Text>
              {isAdmin && (itemsState !== 'ok' || items.length > 0) ? (
                <Pressable
                  onPress={() => {
                    setStatus(null);
                    setManageMode((prev) => !prev);
                  }}
                  hitSlop={6}
                  style={({ pressed }) => [styles.manageToggle, pressed && styles.pressed]}>
                  <Ionicons
                    name={manageMode ? 'checkmark' : 'settings-outline'}
                    size={14}
                    color={colors.ocean}
                  />
                  <Text style={styles.manageToggleText}>
                    {manageMode ? 'Done' : 'Manage list'}
                  </Text>
                </Pressable>
              ) : null}
            </View>

            {itemsState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : itemsState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>The checklist is unavailable right now.</Text>
              </View>
            ) : items.length === 0 && !isAdmin ? (
              <View style={styles.centerCard}>
                <Ionicons name="clipboard" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>
                  No checklist set up for this vehicle yet
                </Text>
              </View>
            ) : items.length > 0 ? (
              <View style={styles.listCard}>
                {items.map((item, index) => {
                  const missing = results[item.id] === false;
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => (manageMode ? undefined : toggleItem(item.id))}
                      disabled={manageMode}
                      style={({ pressed }) => [
                        styles.itemRow,
                        index > 0 && styles.rowBorderTop,
                        missing && styles.itemRowMissing,
                        pressed && !manageMode && styles.rowPressed,
                      ]}>
                      <Ionicons
                        name={missing ? 'close-circle' : 'checkmark-circle'}
                        size={22}
                        color={missing ? colors.danger : colors.ocean}
                      />
                      <Text style={[styles.itemName, missing && styles.itemNameMissing]}>
                        {item.name}
                      </Text>
                      {missing ? <Text style={styles.missingLabel}>Missing</Text> : null}
                      {manageMode ? (
                        <Pressable
                          onPress={() => confirmRemoveItem(item)}
                          hitSlop={8}
                          style={({ pressed }) => [styles.removeButton, pressed && styles.pressed]}>
                          <Ionicons name="close" size={16} color={colors.danger} />
                        </Pressable>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            ) : null}

            {showManageArea ? (
              <View style={styles.formCard}>
                <Text style={styles.formTitle}>
                  {items.length === 0 ? 'Set up this checklist' : 'Add item'}
                </Text>
                <View style={styles.addRow}>
                  <TextInput
                    value={newItemName}
                    onChangeText={setNewItemName}
                    placeholder="e.g. Impact driver"
                    placeholderTextColor={colors.inkSoft}
                    style={[styles.input, styles.addInput]}
                    onSubmitEditing={submitNewItem}
                  />
                  <Pressable
                    onPress={submitNewItem}
                    disabled={addingItem}
                    style={({ pressed }) => [
                      styles.saveButton,
                      (pressed || addingItem) && styles.pressed,
                    ]}>
                    {addingItem ? (
                      <ActivityIndicator color={colors.ink} size="small" />
                    ) : (
                      <Text style={styles.saveButtonText}>Add</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            ) : null}

            {itemsState === 'ok' && items.length > 0 && !manageMode ? (
              <>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Note (optional)"
                  placeholderTextColor={colors.inkSoft}
                  style={styles.input}
                />
                <Pressable
                  onPress={submitCheck}
                  disabled={submitting}
                  style={({ pressed }) => [
                    styles.submitButton,
                    (pressed || submitting) && styles.pressed,
                  ]}>
                  {submitting ? (
                    <ActivityIndicator color={colors.ink} size="small" />
                  ) : (
                    <>
                      <Ionicons name="checkmark-done" size={18} color={colors.ink} />
                      <Text style={styles.submitButtonText}>
                        Submit check
                        {missingCount > 0 ? ` (${missingCount} missing)` : ''}
                      </Text>
                    </>
                  )}
                </Pressable>
              </>
            ) : null}

            <Text style={styles.sectionTitle}>Recent checks</Text>
            {runs.length === 0 ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>No checks recorded for this vehicle yet.</Text>
              </View>
            ) : (
              <View style={styles.listCard}>
                {runs.map((run, index) => (
                  <View key={run.id} style={[styles.runRow, index > 0 && styles.rowBorderTop]}>
                    <View style={styles.runBody}>
                      <Text style={styles.runDate}>{formatShortDate(run.run_date)}</Text>
                      <Text style={styles.runMeta}>{employeeLabel(run.employee)}</Text>
                      {run.note ? <Text style={styles.runNote}>{run.note}</Text> : null}
                    </View>
                    <View
                      style={[
                        styles.runPill,
                        run.missing_count > 0 ? styles.runPillBad : styles.runPillGood,
                      ]}>
                      <Text
                        style={[
                          styles.runPillText,
                          { color: run.missing_count > 0 ? colors.danger : colors.ocean },
                        ]}>
                        {run.missing_count > 0 ? `${run.missing_count} missing` : 'All good'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
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
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  vehicleChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.white,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  chipSelected: {
    backgroundColor: colors.sun,
    borderColor: colors.sun,
  },
  chipText: {
    color: colors.inkSoft,
    fontSize: 14,
    fontWeight: '700',
  },
  chipTextSelected: {
    color: colors.ink,
  },
  checkHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  manageToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.skySoft,
  },
  manageToggleText: {
    color: colors.ocean,
    fontSize: 13,
    fontWeight: '800',
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
    gap: spacing.md,
    padding: spacing.md,
  },
  itemRowMissing: {
    backgroundColor: DANGER_TINT,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  pressed: {
    opacity: 0.7,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  itemName: {
    flex: 1,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  itemNameMissing: {
    color: colors.danger,
  },
  missingLabel: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  removeButton: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  formTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  addInput: {
    flex: 1,
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
    backgroundColor: colors.white,
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
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.md - 2,
    paddingHorizontal: spacing.lg,
    ...shadows.card,
  },
  submitButtonText: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '800',
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  runBody: {
    flex: 1,
    gap: 2,
  },
  runDate: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '700',
  },
  runMeta: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  runNote: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  runPill: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  runPillGood: {
    backgroundColor: colors.skySoft,
  },
  runPillBad: {
    backgroundColor: DANGER_TINT,
  },
  runPillText: {
    fontSize: 12,
    fontWeight: '800',
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
