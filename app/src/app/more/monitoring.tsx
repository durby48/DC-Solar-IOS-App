import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  AnimatedPressable,
  AppText,
  Button,
  Card,
  EmptyState,
  FadeInUp,
  Screen,
  SectionHeader,
  SkeletonList,
} from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { haptics } from '@/lib/haptics';
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
      haptics.success();
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
      haptics.success();
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
      haptics.warn();
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
      <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
        Label
      </AppText>
      <TextInput
        value={form.label}
        onChangeText={(v) => setForm({ ...form, label: v })}
        placeholder="e.g. Enphase — Smith residence"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
        URL (optional)
      </AppText>
      <TextInput
        value={form.url}
        onChangeText={(v) => setForm({ ...form, url: v })}
        placeholder="e.g. enlighten.enphaseenergy.com"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        style={styles.input}
      />
      <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
        Username (optional)
      </AppText>
      <TextInput
        value={form.username}
        onChangeText={(v) => setForm({ ...form, username: v })}
        placeholder="e.g. installs@dcsolarkc.com"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
        Password (optional)
      </AppText>
      <TextInput
        value={form.secret}
        onChangeText={(v) => setForm({ ...form, secret: v })}
        placeholder="Password"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <AppText variant="section" color={colors.textMuted} style={styles.fieldLabel}>
        Notes (optional)
      </AppText>
      <TextInput
        value={form.notes}
        onChangeText={(v) => setForm({ ...form, notes: v })}
        placeholder="Anything the crew should know"
        placeholderTextColor={colors.textMuted}
        multiline
        style={[styles.input, styles.inputMultiline]}
      />
      <View style={styles.formButtons}>
        <Button label="Cancel" variant="ghost" size="sm" disabled={saving} onPress={onCancel} />
        <Button label={saveLabel} size="sm" loading={saving} onPress={onSave} />
      </View>
    </>
  );

  const renderLoginCard = (login: MonitoringLogin, index: number) => {
    const revealed = revealedIds.has(login.id);
    const editing = editingId === login.id;
    return (
      <FadeInUp key={login.id} index={index}>
        <Card style={styles.loginCard}>
          {editing ? (
            <>
              <AppText variant="heading">Edit login</AppText>
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
                  <Ionicons name="pulse" size={18} color={colors.accentPrimary} />
                </View>
                <AppText variant="heading" style={styles.loginLabel}>
                  {login.label}
                </AppText>
              </View>

              {login.url ? (
                <AnimatedPressable
                  onPress={() => openUrl(login.url as string)}
                  haptic="tapLight"
                  scaleTo={0.99}
                  accessibilityRole="link"
                  accessibilityLabel={`Open ${login.url}`}
                  style={({ pressed }) => [styles.detailRow, pressed && styles.rowPressed]}>
                  <AppText variant="section" color={colors.textMuted}>
                    URL
                  </AppText>
                  <View style={styles.linkRow}>
                    <AppText
                      variant="bodyStrong"
                      color={colors.accentLink}
                      numberOfLines={1}
                      style={styles.linkText}>
                      {login.url}
                    </AppText>
                    <Ionicons name="open-outline" size={15} color={colors.accentLink} />
                  </View>
                </AnimatedPressable>
              ) : null}

              {login.username ? (
                <View style={styles.detailRow}>
                  <AppText variant="section" color={colors.textMuted}>
                    Username
                  </AppText>
                  {/* `selectable` is why this stays a bare Text: the crew copies
                      these into a browser, and AppText has no selectable prop. */}
                  <Text selectable style={styles.detailValue}>
                    {login.username}
                  </Text>
                </View>
              ) : null}

              {login.secret ? (
                <View style={styles.detailRow}>
                  <AppText variant="section" color={colors.textMuted}>
                    Password
                  </AppText>
                  <View style={styles.secretRow}>
                    <Text selectable={revealed} style={styles.detailValue}>
                      {revealed ? login.secret : '••••••••'}
                    </Text>
                    <AnimatedPressable
                      onPress={() => toggleReveal(login.id)}
                      haptic="tapLight"
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={revealed ? 'Hide password' : 'Show password'}
                      style={styles.eyeButton}>
                      <Ionicons
                        name={revealed ? 'eye-off' : 'eye'}
                        size={18}
                        color={colors.accentPrimary}
                      />
                    </AnimatedPressable>
                  </View>
                </View>
              ) : null}

              {login.notes ? (
                <View style={styles.detailRow}>
                  <AppText variant="section" color={colors.textMuted}>
                    Notes
                  </AppText>
                  <AppText variant="body">{login.notes}</AppText>
                </View>
              ) : null}

              {isAdmin ? (
                <View style={styles.adminRow}>
                  <Button
                    label="Edit"
                    icon="pencil"
                    variant="secondary"
                    size="sm"
                    onPress={() => startEdit(login)}
                  />
                  {/* Two-tap confirm: the first tap ARMS the button, which is
                      why the un-armed state is an outline and the armed one is
                      the solid danger Button. Same behaviour as before — the
                      screen just says "this is about to happen" louder. */}
                  {confirmDeleteId === login.id ? (
                    <Button
                      label="Tap again to delete"
                      icon="trash"
                      variant="danger"
                      size="sm"
                      loading={deletingId === login.id}
                      haptic="warn"
                      onPress={() => pressDelete(login)}
                    />
                  ) : (
                    <AnimatedPressable
                      onPress={() => pressDelete(login)}
                      haptic="tapMedium"
                      accessibilityRole="button"
                      accessibilityLabel={`Delete ${login.label}`}
                      style={styles.dangerGhost}>
                      <Ionicons name="trash" size={15} color={colors.danger} />
                      <AppText variant="button" color={colors.danger} style={styles.dangerGhostText}>
                        Delete
                      </AppText>
                    </AnimatedPressable>
                  )}
                </View>
              ) : null}
            </>
          )}
        </Card>
      </FadeInUp>
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: 'Monitoring Logins' }} />
      <Screen edges={[]}>
        {auth.state === 'loading' ? (
          <SkeletonList count={3} height={120} />
        ) : auth.state === 'out' ? (
          <Card>
            <EmptyState
              icon="pulse"
              title="Sign in to view monitoring logins"
              body="Monitoring portal credentials are only visible to signed-in crew members."
            />
          </Card>
        ) : (
          <View style={styles.section}>
            <SectionHeader title="Monitoring portals" icon="pulse" />
            {listState === 'loading' ? (
              <SkeletonList count={3} height={120} />
            ) : listState === 'unavailable' ? (
              <Card>
                <EmptyState
                  icon="cloud-offline-outline"
                  title="Monitoring logins are unavailable right now."
                  body="The list could not be loaded. Try again once you are back on a signal."
                />
              </Card>
            ) : listState === 'missing' ? (
              <Card>
                <EmptyState
                  icon="pulse"
                  title="Nothing here yet"
                  body={
                    isAdmin
                      ? 'Needs the latest database migration.'
                      : 'The office has not saved any monitoring portals yet.'
                  }
                />
              </Card>
            ) : logins.length === 0 ? (
              <Card>
                <EmptyState
                  icon="pulse"
                  title={isAdmin ? 'No logins yet — add the first one' : 'No logins yet'}
                  body="Monitoring portal credentials the office saves show up here for the whole crew."
                />
              </Card>
            ) : (
              <View style={styles.stack}>{logins.map(renderLoginCard)}</View>
            )}

            {isAdmin && (listState === 'ok' || listState === 'missing') ? (
              !showAddForm ? (
                <Button
                  label="Add login"
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
                  <AppText variant="heading">New login</AppText>
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
                </Card>
              )
            ) : null}
          </View>
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
  section: {
    marginTop: spacing.sm,
    gap: spacing.md,
  },
  stack: {
    gap: spacing.md,
  },
  loginCard: {
    gap: spacing.sm,
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
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginLabel: {
    flex: 1,
  },
  detailRow: {
    gap: 2,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  rowPressed: {
    backgroundColor: colors.oliveTint,
  },
  detailValue: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  linkText: {
    flexShrink: 1,
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
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  adminRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
  },
  /** The un-armed Delete: an outline that still reads as destructive. */
  dangerGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs + 2,
    minHeight: 40,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.danger,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.sm + 4,
    alignSelf: 'flex-start',
  },
  dangerGhostText: {
    fontSize: 13,
  },
  formCard: {
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
  inputMultiline: {
    minHeight: 64,
    textAlignVertical: 'top',
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
});
