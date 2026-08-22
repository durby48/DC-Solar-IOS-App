import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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
import { haptics } from '@/lib/haptics';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

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
      // A clean truck is a success; a truck missing tools worked, but the
      // person needs to read the number — hence `warn` rather than `success`.
      if (missingCount === 0) haptics.success();
      else haptics.warn();
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
      haptics.success();
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
      <Stack.Screen options={{ title: 'Vehicle Checklist' }} />
      <Screen edges={[]}>
        {auth.state === 'loading' ? (
          <SkeletonList count={3} height={72} />
        ) : auth.state === 'out' ? (
          <Card>
            <EmptyState
              icon="clipboard"
              title="Sign in to run a vehicle check"
              body="Daily tool checks are recorded per crew member, so sign in first."
            />
          </Card>
        ) : vehiclesState === 'loading' ? (
          <SkeletonList count={3} height={72} />
        ) : vehicles.length === 0 ? (
          <Card>
            <EmptyState
              icon="car"
              title="No vehicles are set up yet."
              body="Once the office adds a truck or van it shows up here with its own tool list."
            />
          </Card>
        ) : (
          <>
            <View style={styles.chipRow}>
              {vehicles.map((vehicle) => (
                <Chip
                  key={vehicle.id}
                  label={vehicle.name}
                  icon={VEHICLE_ICONS[vehicle.kind] ?? 'cube'}
                  tone="olive"
                  selected={vehicleId === vehicle.id}
                  onPress={() => setVehicleId(vehicle.id)}
                />
              ))}
            </View>

            <SectionHeader
              title="Today's check"
              icon="clipboard-outline"
              action={
                isAdmin && (itemsState !== 'ok' || items.length > 0)
                  ? {
                      label: manageMode ? 'Done' : 'Manage list',
                      icon: manageMode ? 'checkmark' : 'settings-outline',
                      onPress: () => {
                        setStatus(null);
                        setManageMode((prev) => !prev);
                      },
                    }
                  : undefined
              }
              style={styles.sectionHeader}
            />

            {itemsState === 'loading' ? (
              <SkeletonList count={5} height={54} />
            ) : itemsState === 'unavailable' ? (
              <Card>
                <EmptyState
                  icon="cloud-offline-outline"
                  title="The checklist is unavailable right now."
                  body="The tool list could not be loaded. Try again once you are back on a signal."
                />
              </Card>
            ) : items.length === 0 && !isAdmin ? (
              <Card>
                <EmptyState
                  icon="clipboard"
                  title="No checklist set up for this vehicle yet"
                  body="The office builds the tool list. Ask them to add one for this vehicle."
                />
              </Card>
            ) : items.length > 0 ? (
              <Card padded={false}>
                {items.map((item, index) => {
                  const missing = results[item.id] === false;
                  return (
                    <FadeInUp key={item.id} index={index}>
                      <AnimatedPressable
                        onPress={() => (manageMode ? undefined : toggleItem(item.id))}
                        disabled={manageMode}
                        haptic={manageMode ? undefined : 'tapLight'}
                        scaleTo={0.99}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: !missing, disabled: manageMode }}
                        accessibilityLabel={item.name}
                        style={({ pressed }) => [
                          styles.itemRow,
                          index > 0 && styles.rowBorderTop,
                          missing && styles.itemRowMissing,
                          pressed && !manageMode && styles.rowPressed,
                        ]}>
                        <Ionicons
                          name={missing ? 'close-circle' : 'checkmark-circle'}
                          size={22}
                          color={missing ? colors.danger : colors.accentPrimary}
                        />
                        <AppText
                          variant="bodyStrong"
                          color={missing ? colors.danger : colors.textPrimary}
                          style={styles.itemName}>
                          {item.name}
                        </AppText>
                        {missing ? (
                          <AppText variant="section" color={colors.danger}>
                            Missing
                          </AppText>
                        ) : null}
                        {manageMode ? (
                          <AnimatedPressable
                            onPress={() => confirmRemoveItem(item)}
                            haptic="tapMedium"
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove ${item.name}`}
                            style={styles.removeButton}>
                            <Ionicons name="close" size={16} color={colors.danger} />
                          </AnimatedPressable>
                        ) : null}
                      </AnimatedPressable>
                    </FadeInUp>
                  );
                })}
              </Card>
            ) : null}

            {showManageArea ? (
              <Card style={styles.formCard}>
                <AppText variant="heading">
                  {items.length === 0 ? 'Set up this checklist' : 'Add item'}
                </AppText>
                <View style={styles.addRow}>
                  <TextInput
                    value={newItemName}
                    onChangeText={setNewItemName}
                    placeholder="e.g. Impact driver"
                    placeholderTextColor={colors.textMuted}
                    style={[styles.input, styles.addInput]}
                    onSubmitEditing={submitNewItem}
                  />
                  <Button label="Add" size="sm" loading={addingItem} onPress={submitNewItem} />
                </View>
              </Card>
            ) : null}

            {itemsState === 'ok' && items.length > 0 && !manageMode ? (
              <>
                <TextInput
                  value={note}
                  onChangeText={setNote}
                  placeholder="Note (optional)"
                  placeholderTextColor={colors.textMuted}
                  style={styles.input}
                />
                <Button
                  label={`Submit check${missingCount > 0 ? ` (${missingCount} missing)` : ''}`}
                  icon="checkmark-done"
                  size="lg"
                  fullWidth
                  loading={submitting}
                  onPress={submitCheck}
                />
              </>
            ) : null}

            <SectionHeader
              title="Recent checks"
              icon="time-outline"
              style={styles.sectionHeader}
            />
            {runs.length === 0 ? (
              <Card>
                <EmptyState
                  icon="time-outline"
                  title="No checks recorded for this vehicle yet."
                  body="Submit today's check and it lands here for everyone to see."
                />
              </Card>
            ) : (
              <Card padded={false}>
                {runs.map((run, index) => (
                  <FadeInUp key={run.id} index={index}>
                    <View style={[styles.runRow, index > 0 && styles.rowBorderTop]}>
                      <View style={styles.runBody}>
                        <AppText variant="bodyStrong">{formatShortDate(run.run_date)}</AppText>
                        <AppText variant="caption" color={colors.textMuted}>
                          {employeeLabel(run.employee)}
                        </AppText>
                        {run.note ? (
                          <AppText
                            variant="caption"
                            color={colors.textSecondary}
                            style={styles.runNote}>
                            {run.note}
                          </AppText>
                        ) : null}
                      </View>
                      <Pill
                        label={
                          run.missing_count > 0 ? `${run.missing_count} missing` : 'All good'
                        }
                        bg={run.missing_count > 0 ? colors.coralSoft : colors.mintSoft}
                        fg={run.missing_count > 0 ? colors.coralDeep : colors.mintDeep}
                      />
                    </View>
                  </FadeInUp>
                ))}
              </Card>
            )}
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

/** Danger tint for a "missing" row — the theme's danger at 10 % on white. */
const DANGER_TINT = `${colors.danger}1A`;

const styles = StyleSheet.create({
  sectionHeader: {
    marginTop: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  itemRowMissing: {
    backgroundColor: DANGER_TINT,
  },
  rowPressed: {
    backgroundColor: colors.oliveTint,
  },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  itemName: {
    flex: 1,
  },
  removeButton: {
    width: 28,
    height: 28,
    borderRadius: radii.pill,
    backgroundColor: colors.dangerSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  formCard: {
    gap: spacing.sm,
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
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm + 4,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: 15,
    backgroundColor: colors.surface,
  },
  runRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.surface,
  },
  runBody: {
    flex: 1,
    gap: 2,
  },
  runNote: {
    fontStyle: 'italic',
  },
});
