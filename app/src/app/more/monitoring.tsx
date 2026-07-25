import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
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
  addMonitoringLogin,
  deleteMonitoringLogin,
  fetchMonitoringLogins,
  updateMonitoringLogin,
  type MonitoringLogin,
  type MonitoringLoginInput,
} from '@/lib/monitoring';
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

function openUrl(raw: string) {
  const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  Linking.openURL(url).catch(() => {});
}

interface FormState {
  label: string;
  url: string;
  username: string;
  secret: string;
  notes: string;
}

const EMPTY_FORM: FormState = { label: '', url: '', username: '', secret: '', notes: '' };

function toInput(form: FormState): MonitoringLoginInput {
  return {
    label: form.label.trim(),
    url: form.url.trim() || null,
    username: form.username.trim() || null,
    secret: form.secret || null,
    notes: form.notes.trim() || null,
  };
}

export default function MonitoringScreen() {
  const auth = useAuthEmail();
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [listState, setListState] = useState<'loading' | 'ok' | 'missing' | 'unavailable'>(
    'loading',
  );
  const [logins, setLogins] = useState<MonitoringLogin[]>([]);
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  // Admin add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(EMPTY_FORM);
  const [adding, setAdding] = useState(false);

  // Admin inline edit
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(EMPTY_FORM);
  const [savingEdit, setSavingEdit] = useState(false);

  // Two-tap delete confirm (works on native and web alike)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(
    null,
  );

  const loadLogins = useCallback(async () => {
    const result = await fetchMonitoringLogins();
    if (result.status === 'ok') {
      setLogins(result.logins);
      setListState('ok');
    } else {
      setLogins([]);
      setListState(result.status);
    }
  }, []);

  useEffect(() => {
    if (auth.state !== 'in') return;
    loadLogins();
  }, [auth.state, loadLogins]);

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const submitAdd = async () => {
    setStatus(null);
    if (!addForm.label.trim()) {
      notify(setStatus, 'error', 'Missing label', 'Give the login a label, e.g. "Enphase — Smith".');
      return;
    }
    setAdding(true);
    const result = await addMonitoringLogin(toInput(addForm));
    if (result.ok) {
      await loadLogins();
      setShowAddForm(false);
      setAddForm(EMPTY_FORM);
      setAdding(false);
      notify(setStatus, 'success', 'Login added', `${addForm.label.trim()} is saved.`);
    } else {
      setAdding(false);
      notify(setStatus, 'error', 'Could not add login', result.message);
    }
  };

  const startEdit = (login: MonitoringLogin) => {
    setStatus(null);
    setConfirmDeleteId(null);
    setEditingId(login.id);
    setEditForm({
      label: login.label,
      url: login.url ?? '',
      username: login.username ?? '',
      secret: login.secret ?? '',
      notes: login.notes ?? '',
    });
  };

  const submitEdit = async (login: MonitoringLogin) => {
    setStatus(null);
    if (!editForm.label.trim()) {
      notify(setStatus, 'error', 'Missing label', 'The label cannot be empty.');
      return;
    }
    setSavingEdit(true);
    const result = await updateMonitoringLogin(login.id, toInput(editForm));
    if (result.ok) {
      await loadLogins();
      setEditingId(null);
      setSavingEdit(false);
      notify(setStatus, 'success', 'Saved', `${editForm.label.trim()} updated.`);
    } else {
      setSavingEdit(false);
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  const pressDelete = async (login: MonitoringLogin) => {
    setStatus(null);
    if (confirmDeleteId !== login.id) {
      setConfirmDeleteId(login.id);
      return;
    }
    setDeletingId(login.id);
    const result = await deleteMonitoringLogin(login.id);
    setDeletingId(null);
    setConfirmDeleteId(null);
    if (result.ok) {
      await loadLogins();
      notify(setStatus, 'success', 'Deleted', `${login.label} removed.`);
    } else {
      notify(setStatus, 'error', 'Could not delete', result.message);
    }
  };

  const renderForm = (
    form: FormState,
    setForm: (f: FormState) => void,
    onCancel: () => void,
    onSave: () => void,
    saving: boolean,
    saveLabel: string,
  ) => (
    <>
      <Text style={styles.fieldLabel}>Label</Text>
      <TextInput
        value={form.label}
        onChangeText={(v) => setForm({ ...form, label: v })}
        placeholder='e.g. Enphase — Smith residence'
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>URL (optional)</Text>
      <TextInput
        value={form.url}
        onChangeText={(v) => setForm({ ...form, url: v })}
        placeholder="e.g. enlighten.enphaseenergy.com"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Username (optional)</Text>
      <TextInput
        value={form.username}
        onChangeText={(v) => setForm({ ...form, username: v })}
        placeholder="e.g. installs@dcsolarkc.com"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Password (optional)</Text>
      <TextInput
        value={form.secret}
        onChangeText={(v) => setForm({ ...form, secret: v })}
        placeholder="Password"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Text style={styles.fieldLabel}>Notes (optional)</Text>
      <TextInput
        value={form.notes}
        onChangeText={(v) => setForm({ ...form, notes: v })}
        placeholder="Anything the crew should know"
        placeholderTextColor={colors.inkSoft}
        multiline
        style={[styles.input, styles.inputMultiline]}
      />
      <View style={styles.formButtons}>
        <Pressable
          onPress={onCancel}
          disabled={saving}
          style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={onSave}
          disabled={saving}
          style={({ pressed }) => [styles.saveButton, (pressed || saving) && styles.pressed]}>
          {saving ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Text style={styles.saveButtonText}>{saveLabel}</Text>
          )}
        </Pressable>
      </View>
    </>
  );

  const renderLoginCard = (login: MonitoringLogin) => {
    const revealed = revealedIds.has(login.id);
    const editing = editingId === login.id;
    return (
      <View key={login.id} style={styles.loginCard}>
        {editing ? (
          <>
            <Text style={styles.formTitle}>Edit login</Text>
            {renderForm(
              editForm,
              setEditForm,
              () => setEditingId(null),
              () => submitEdit(login),
              savingEdit,
              'Save',
            )}
          </>
        ) : (
          <>
            <View style={styles.loginHeader}>
              <View style={styles.iconWrap}>
                <Ionicons name="pulse" size={18} color={colors.ocean} />
              </View>
              <Text style={styles.loginLabel}>{login.label}</Text>
            </View>

            {login.url ? (
              <Pressable
                onPress={() => openUrl(login.url as string)}
                style={({ pressed }) => [styles.detailRow, pressed && styles.rowPressed]}>
                <Text style={styles.detailLabel}>URL</Text>
                <View style={styles.linkRow}>
                  <Text style={styles.linkText} numberOfLines={1}>
                    {login.url}
                  </Text>
                  <Ionicons name="open-outline" size={15} color={colors.ocean} />
                </View>
              </Pressable>
            ) : null}

            {login.username ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Username</Text>
                <Text selectable style={styles.detailValue}>
                  {login.username}
                </Text>
              </View>
            ) : null}

            {login.secret ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Password</Text>
                <View style={styles.secretRow}>
                  <Text selectable={revealed} style={styles.detailValue}>
                    {revealed ? login.secret : '••••••••'}
                  </Text>
                  <Pressable
                    onPress={() => toggleReveal(login.id)}
                    hitSlop={8}
                    style={({ pressed }) => [styles.eyeButton, pressed && styles.pressed]}>
                    <Ionicons
                      name={revealed ? 'eye-off' : 'eye'}
                      size={18}
                      color={colors.ocean}
                    />
                  </Pressable>
                </View>
              </View>
            ) : null}

            {login.notes ? (
              <View style={styles.detailRow}>
                <Text style={styles.detailLabel}>Notes</Text>
                <Text style={styles.notesText}>{login.notes}</Text>
              </View>
            ) : null}

            {isAdmin ? (
              <View style={styles.adminRow}>
                <Pressable
                  onPress={() => startEdit(login)}
                  style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}>
                  <Ionicons name="pencil" size={14} color={colors.ink} />
                  <Text style={styles.editButtonText}>Edit</Text>
                </Pressable>
                <Pressable
                  onPress={() => pressDelete(login)}
                  disabled={deletingId === login.id}
                  style={({ pressed }) => [
                    styles.deleteButton,
                    confirmDeleteId === login.id && styles.deleteButtonConfirm,
                    (pressed || deletingId === login.id) && styles.pressed,
                  ]}>
                  {deletingId === login.id ? (
                    <ActivityIndicator color={colors.danger} size="small" />
                  ) : (
                    <>
                      <Ionicons name="trash" size={14} color={colors.danger} />
                      <Text style={styles.deleteButtonText}>
                        {confirmDeleteId === login.id ? 'Tap again to delete' : 'Delete'}
                      </Text>
                    </>
                  )}
                </Pressable>
              </View>
            ) : null}
          </>
        )}
      </View>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Monitoring Logins' }} />
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
              <Ionicons name="pulse" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to view monitoring logins</Text>
            <Text style={styles.promptText}>
              Monitoring portal credentials are only visible to signed-in crew members.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.sectionTitle}>Monitoring portals</Text>
            {listState === 'loading' ? (
              <View style={styles.centerCard}>
                <ActivityIndicator color={colors.ocean} />
              </View>
            ) : listState === 'unavailable' ? (
              <View style={styles.centerCard}>
                <Text style={styles.promptText}>Monitoring logins are unavailable right now.</Text>
              </View>
            ) : listState === 'missing' ? (
              <View style={styles.centerCard}>
                <Ionicons name="pulse" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>Nothing here yet</Text>
                {isAdmin ? (
                  <Text style={styles.migrationNote}>Needs the latest database migration.</Text>
                ) : null}
              </View>
            ) : logins.length === 0 ? (
              <View style={styles.centerCard}>
                <Ionicons name="pulse" size={22} color={colors.inkSoft} />
                <Text style={styles.promptText}>
                  {isAdmin ? 'No logins yet — add the first one' : 'No logins yet'}
                </Text>
              </View>
            ) : (
              logins.map(renderLoginCard)
            )}

            {isAdmin && (listState === 'ok' || listState === 'missing') ? (
              !showAddForm ? (
                <Pressable
                  onPress={() => {
                    setStatus(null);
                    setShowAddForm(true);
                  }}
                  style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
                  <Ionicons name="add" size={18} color={colors.ink} />
                  <Text style={styles.addButtonText}>Add login</Text>
                </Pressable>
              ) : (
                <View style={styles.formCard}>
                  <Text style={styles.formTitle}>New login</Text>
                  {renderForm(
                    addForm,
                    setAddForm,
                    () => {
                      setShowAddForm(false);
                      setAddForm(EMPTY_FORM);
                    },
                    submitAdd,
                    adding,
                    'Add login',
                  )}
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
  migrationNote: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    textAlign: 'center',
  },
  loginCard: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  loginHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconWrap: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginLabel: {
    flex: 1,
    color: colors.ink,
    fontSize: 16,
    fontWeight: '800',
  },
  detailRow: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
    paddingTop: spacing.sm,
  },
  rowPressed: {
    backgroundColor: colors.skySoft,
  },
  detailLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  detailValue: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '600',
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  linkText: {
    flexShrink: 1,
    color: colors.ocean,
    fontSize: 15,
    fontWeight: '700',
  },
  secretRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  eyeButton: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notesText: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  adminRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
    paddingTop: spacing.sm,
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sunLight,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
  },
  editButtonText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '800',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderRadius: radii.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.md,
    borderWidth: 1,
    borderColor: colors.danger,
  },
  deleteButtonConfirm: {
    backgroundColor: '#F8E4E1',
  },
  deleteButtonText: {
    color: colors.danger,
    fontSize: 13,
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
