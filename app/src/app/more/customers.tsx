import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
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
  addCustomer,
  fetchCustomers,
  updateCustomer,
  type CustomerInput,
  type CustomerRecord,
} from '@/lib/customers';
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

function open(url: string) {
  Linking.openURL(url).catch(() => {});
}

interface FormState {
  name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
}

const EMPTY_FORM: FormState = { name: '', phone: '', email: '', address: '', notes: '' };

function toInput(form: FormState): CustomerInput {
  return {
    name: form.name.trim(),
    phone: form.phone.trim() || null,
    email: form.email.trim() || null,
    address: form.address.trim() || null,
    notes: form.notes.trim() || null,
  };
}

export default function CustomersScreen() {
  const auth = useAuthEmail();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [listState, setListState] = useState<'loading' | 'ok' | 'unavailable'>('loading');
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [search, setSearch] = useState('');

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [savingEdit, setSavingEdit] = useState(false);

  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const loadCustomers = useCallback(async () => {
    const result = await fetchCustomers();
    if (result.status === 'ok') {
      setCustomers(result.customers);
      setListState('ok');
    } else {
      setCustomers([]);
      setListState('unavailable');
    }
  }, []);

  useEffect(() => {
    if (auth.state !== 'in') return;
    loadCustomers();
  }, [auth.state, loadCustomers]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return customers;
    return customers.filter((c) => c.name.toLowerCase().includes(q));
  }, [customers, search]);

  const toggleExpand = (customer: CustomerRecord) => {
    setStatus(null);
    if (expandedId === customer.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(customer.id);
    setEditForm({
      name: customer.name,
      phone: customer.phone ?? '',
      email: customer.email ?? '',
      address: customer.address ?? '',
      notes: customer.notes ?? '',
    });
  };

  const submitEdit = async (customer: CustomerRecord) => {
    setStatus(null);
    if (!editForm.name.trim()) {
      notify(setStatus, 'error', 'Missing name', 'The customer needs a name.');
      return;
    }
    setSavingEdit(true);
    const result = await updateCustomer(customer.id, toInput(editForm));
    if (result.ok) {
      await loadCustomers();
      setExpandedId(null);
      setSavingEdit(false);
      notify(setStatus, 'success', 'Saved', `${editForm.name.trim()} updated.`);
    } else {
      setSavingEdit(false);
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  const submitAdd = async () => {
    setStatus(null);
    if (!addForm.name.trim()) {
      notify(setStatus, 'error', 'Missing name', 'Give the customer a name.');
      return;
    }
    setAdding(true);
    const result = await addCustomer(toInput(addForm));
    if (result.ok) {
      await loadCustomers();
      setShowAddForm(false);
      setAddForm(EMPTY_FORM);
      setAdding(false);
      notify(setStatus, 'success', 'Customer added', `${addForm.name.trim()} is saved.`);
    } else {
      setAdding(false);
      notify(setStatus, 'error', 'Could not add customer', result.message);
    }
  };

  const renderContactRows = (customer: CustomerRecord) => {
    const rows: {
      key: string;
      icon: keyof typeof Ionicons.glyphMap;
      label: string;
      value: string;
      onPress: () => void;
    }[] = [];
    if (customer.phone) {
      const phone = customer.phone;
      rows.push({
        key: 'phone',
        icon: 'call',
        label: 'Phone',
        value: phone,
        onPress: () => open('tel:' + phone.replace(/[^+\d]/g, '')),
      });
    }
    if (customer.email) {
      const email = customer.email;
      rows.push({
        key: 'email',
        icon: 'mail',
        label: 'Email',
        value: email,
        onPress: () => open('mailto:' + email),
      });
    }
    if (customer.address) {
      const address = customer.address;
      rows.push({
        key: 'address',
        icon: 'home',
        label: 'Address',
        value: address,
        onPress: () => open('https://maps.apple.com/?daddr=' + encodeURIComponent(address)),
      });
    }
    return rows.map((row) => (
      <Pressable
        key={row.key}
        onPress={row.onPress}
        style={({ pressed }) => [styles.contactRow, pressed && styles.rowPressed]}>
        <View style={styles.iconWrap}>
          <Ionicons name={row.icon} size={18} color={colors.ocean} />
        </View>
        <View style={styles.contactBody}>
          <Text style={styles.contactLabel}>{row.label}</Text>
          <Text style={styles.contactValue}>{row.value}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.inkSoft} />
      </Pressable>
    ));
  };

  const renderEditForm = (customer: CustomerRecord) => (
    <View style={styles.editArea}>
      <Text style={styles.formTitle}>Edit customer</Text>
      <Text style={styles.fieldLabel}>Name</Text>
      <TextInput
        value={editForm.name}
        onChangeText={(v) => setEditForm({ ...editForm, name: v })}
        placeholder="Full name"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Phone (optional)</Text>
      <TextInput
        value={editForm.phone}
        onChangeText={(v) => setEditForm({ ...editForm, phone: v })}
        placeholder="e.g. (816) 555-0123"
        placeholderTextColor={colors.inkSoft}
        keyboardType="phone-pad"
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Email (optional)</Text>
      <TextInput
        value={editForm.email}
        onChangeText={(v) => setEditForm({ ...editForm, email: v })}
        placeholder="e.g. name@example.com"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Address (optional)</Text>
      <TextInput
        value={editForm.address}
        onChangeText={(v) => setEditForm({ ...editForm, address: v })}
        placeholder="Street, city, state"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Notes (optional)</Text>
      <TextInput
        value={editForm.notes}
        onChangeText={(v) => setEditForm({ ...editForm, notes: v })}
        placeholder="Anything worth remembering"
        placeholderTextColor={colors.inkSoft}
        multiline
        style={[styles.input, styles.inputMultiline]}
      />
      <View style={styles.formButtons}>
        <Pressable
          onPress={() => setExpandedId(null)}
          disabled={savingEdit}
          style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => submitEdit(customer)}
          disabled={savingEdit}
          style={({ pressed }) => [styles.saveButton, (pressed || savingEdit) && styles.pressed]}>
          {savingEdit ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Text style={styles.saveButtonText}>Save</Text>
          )}
        </Pressable>
      </View>
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Customers' }} />
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
              <Ionicons name="people" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to view customers</Text>
            <Text style={styles.promptText}>
              Customer contact details are only visible to signed-in crew members.
            </Text>
          </View>
        ) : (
          <>
            <View style={styles.searchWrap}>
              <Ionicons name="search" size={16} color={colors.inkSoft} />
              <TextInput
                value={search}
                onChangeText={setSearch}
                placeholder="Search by name"
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

            {listState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : listState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>Customers are unavailable right now.</Text>
              </View>
            ) : filtered.length === 0 ? (
              <View style={styles.centerCard}>
                <Ionicons name="people" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>
                  {search.trim()
                    ? 'No customers match that search'
                    : isAdmin
                      ? 'No customers yet — add the first one'
                      : 'No customers yet'}
                </Text>
              </View>
            ) : (
              filtered.map((customer) => {
                const expanded = expandedId === customer.id;
                return (
                  <View key={customer.id} style={styles.customerCard}>
                    <Pressable
                      onPress={() => (isAdmin ? toggleExpand(customer) : undefined)}
                      disabled={!isAdmin}
                      style={({ pressed }) => [
                        styles.nameRow,
                        pressed && isAdmin && styles.rowPressed,
                      ]}>
                      <View style={styles.iconWrap}>
                        <Ionicons name="person" size={18} color={colors.ocean} />
                      </View>
                      <Text style={styles.customerName}>{customer.name}</Text>
                      {isAdmin ? (
                        <Ionicons
                          name={expanded ? 'chevron-up' : 'pencil'}
                          size={16}
                          color={colors.inkSoft}
                        />
                      ) : null}
                    </Pressable>
                    {expanded && isAdmin ? (
                      renderEditForm(customer)
                    ) : (
                      <>
                        {renderContactRows(customer)}
                        {customer.notes ? (
                          <View style={styles.notesRow}>
                            <Text style={styles.contactLabel}>Notes</Text>
                            <Text style={styles.notesText}>{customer.notes}</Text>
                          </View>
                        ) : null}
                      </>
                    )}
                  </View>
                );
              })
            )}

            {isAdmin && listState === 'ok' ? (
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
                      onPress={submitAdd}
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
  customerCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    overflow: 'hidden',
    ...shadows.card,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  customerName: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  contactBody: {
    flex: 1,
    gap: 2,
  },
  contactLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  contactValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  notesRow: {
    padding: spacing.md,
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  notesText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  editArea: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.xs,
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
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
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
