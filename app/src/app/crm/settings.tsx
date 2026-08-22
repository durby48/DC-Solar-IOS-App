import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  createTemplate,
  deleteTemplate,
  fetchCommsSettings,
  fetchMyStaffProfile,
  fetchTemplates,
  formatPhone,
  renderTemplate,
  saveCommsSettings,
  saveMyCellPhone,
  sendSms,
  setMyVoiceBridge,
  updateTemplate,
  type CommsSettings,
  type MessageTemplate,
  type StaffProfile,
} from '@/lib/comms';
import { useRole } from '@/lib/role';
import { supabase } from '@/lib/supabase';

/**
 * `/crm/settings` — everything about texting and calling from the DC Solar
 * number, in the order somebody setting it up needs it.
 *
 * MY CELL COMES FIRST and it is not a vanity field: a bridge call rings THAT
 * phone before it dials the customer, so with it blank the Call button simply
 * refuses. It is stored in `staff_profiles`, deliberately not as a column on
 * `employees` — that table's security rests on having zero write policies and
 * it must keep it.
 *
 * THE COMPANY SETTINGS below it are admin-only in RLS, so the gate here is
 * cosmetic; a viewer's UPDATE would match zero rows anyway, which is exactly
 * what `saveCommsSettings` reports as a permission problem.
 *
 * THE TEMPLATE EDITOR enforces one rule the database only documents in a
 * comment: every saved text must end with "Reply STOP to opt out." That
 * sentence is part of the A2P 10DLC campaign registration, and a campaign is
 * revocable. The editor warns rather than blocks — Devon may have a reason —
 * but it never lets one go out silently missing.
 */

/** Show success/error feedback: Alert on native, inline status text on web. */
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

const STOP_SENTENCE = /reply\s+stop\s+to\s+opt\s+out/i;

/** 'HH:MM:SS' → 'HH:MM' for the text inputs; anything odd passes through. */
function shortTime(value: string): string {
  return /^\d{2}:\d{2}/.test(value) ? value.slice(0, 5) : value;
}

interface TemplateDraft {
  key: string;
  title: string;
  body: string;
  active: boolean;
  sort: string;
}

const EMPTY_DRAFT: TemplateDraft = { key: '', title: '', body: '', active: true, sort: '100' };

export default function MessagingSettingsScreen() {
  const role = useRole();
  const isAdmin = role?.isAdmin ?? false;

  const [authState, setAuthState] = useState<'loading' | 'out' | 'in'>('loading');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // My profile
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [cellDraft, setCellDraft] = useState('');
  const [cellBusy, setCellBusy] = useState(false);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);

  // Company settings
  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [fromDraft, setFromDraft] = useState('');
  const [smsEnabled, setSmsEnabled] = useState(false);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [hoursStart, setHoursStart] = useState('07:00');
  const [hoursEnd, setHoursEnd] = useState('18:00');
  const [autoreply, setAutoreply] = useState('');
  const [reviewLink, setReviewLink] = useState('');
  const [settingsBusy, setSettingsBusy] = useState(false);

  // Templates
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editSort, setEditSort] = useState('0');
  const [templateBusy, setTemplateBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<TemplateDraft>(EMPTY_DRAFT);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setAuthState(data.session?.user?.email ? 'in' : 'out');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (cancelled) return;
      setAuthState(session?.user?.email ? 'in' : 'out');
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const load = useCallback(async () => {
    const [settingsRow, profileRow, templateRows] = await Promise.all([
      fetchCommsSettings(),
      fetchMyStaffProfile(),
      fetchTemplates({ includeInactive: true }),
    ]);
    setSettings(settingsRow);
    setProfile(profileRow);
    setTemplates(templateRows);
    setCellDraft(profileRow?.cellPhone ?? '');
    if (settingsRow) {
      setFromDraft(settingsRow.fromNumber ?? '');
      setSmsEnabled(settingsRow.smsEnabled);
      setVoiceEnabled(settingsRow.voiceEnabled);
      setHoursStart(shortTime(settingsRow.businessHoursStart));
      setHoursEnd(shortTime(settingsRow.businessHoursEnd));
      setAutoreply(settingsRow.afterHoursAutoreply ?? '');
      setReviewLink(settingsRow.reviewLink ?? '');
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (authState === 'out') {
        setLoading(false);
        return;
      }
      if (authState !== 'in') return;
      void load();
    }, [authState, load]),
  );

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const saveCell = async () => {
    setCellBusy(true);
    const result = await saveMyCellPhone(cellDraft.trim() || null);
    setCellBusy(false);
    if (result.ok) {
      await load();
      notify(setStatus, 'success', 'Saved', 'That is the phone a bridge call rings first.');
    } else {
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  const toggleBridge = async (next: boolean) => {
    setBridgeBusy(true);
    const result = await setMyVoiceBridge(next);
    setBridgeBusy(false);
    if (result.ok) await load();
    else notify(setStatus, 'error', 'Could not save', result.message);
  };

  const saveSettings = async () => {
    setSettingsBusy(true);
    const result = await saveCommsSettings({
      fromNumber: fromDraft.trim() || null,
      smsEnabled,
      voiceEnabled,
      businessHoursStart: /^\d{1,2}:\d{2}$/.test(hoursStart.trim())
        ? `${hoursStart.trim()}:00`
        : undefined,
      businessHoursEnd: /^\d{1,2}:\d{2}$/.test(hoursEnd.trim()) ? `${hoursEnd.trim()}:00` : undefined,
      afterHoursAutoreply: autoreply.trim() || null,
      reviewLink: reviewLink.trim() || null,
    });
    setSettingsBusy(false);
    if (result.ok) {
      await load();
      notify(setStatus, 'success', 'Saved', 'Messaging settings updated.');
    } else {
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  /**
   * Send a real text to my own cell. The best proof the whole chain works:
   * the edge function, the A2P campaign, the number and the delivery callback
   * all have to be right for it to arrive.
   */
  const sendTest = async () => {
    const to = profile?.cellPhoneE164 ?? profile?.cellPhone ?? cellDraft.trim();
    if (!to) {
      notify(setStatus, 'error', 'No number', 'Save your cell number first.');
      return;
    }
    setTestBusy(true);
    const result = await sendSms({
      to,
      body: 'DC Solar KC: test message from the app. Reply STOP to opt out.',
    });
    setTestBusy(false);
    if (result.ok) {
      notify(setStatus, 'success', 'Test sent', `Texted ${formatPhone(to)} — status: ${result.status}.`);
    } else {
      notify(setStatus, 'error', 'Test failed', result.message);
    }
  };

  const startEdit = (template: MessageTemplate) => {
    setAdding(false);
    setEditingId(template.id);
    setEditTitle(template.title);
    setEditBody(template.body);
    setEditSort(String(template.sort));
    setConfirmDeleteId(null);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setTemplateBusy(true);
    const result = await updateTemplate(editingId, {
      title: editTitle,
      body: editBody,
      sort: Number(editSort) || 0,
    });
    setTemplateBusy(false);
    if (result.ok) {
      setEditingId(null);
      await load();
      notify(setStatus, 'success', 'Saved', 'Template updated.');
    } else {
      notify(setStatus, 'error', 'Could not save', result.message);
    }
  };

  const toggleActive = async (template: MessageTemplate) => {
    const result = await updateTemplate(template.id, { active: !template.active });
    if (result.ok) await load();
    else notify(setStatus, 'error', 'Could not save', result.message);
  };

  const pressDelete = async (template: MessageTemplate) => {
    if (confirmDeleteId !== template.id) {
      setConfirmDeleteId(template.id);
      return;
    }
    setConfirmDeleteId(null);
    const result = await deleteTemplate(template.id);
    if (result.ok) {
      await load();
      notify(setStatus, 'success', 'Deleted', `"${template.title}" is gone.`);
    } else {
      notify(setStatus, 'error', 'Could not delete', result.message);
    }
  };

  const saveNew = async () => {
    setTemplateBusy(true);
    const result = await createTemplate({
      key: draft.key,
      title: draft.title,
      body: draft.body,
      active: draft.active,
      sort: Number(draft.sort) || 100,
    });
    setTemplateBusy(false);
    if (result.ok) {
      setAdding(false);
      setDraft(EMPTY_DRAFT);
      await load();
      notify(setStatus, 'success', 'Added', 'The saved text is ready to use.');
    } else {
      notify(setStatus, 'error', 'Could not add', result.message);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const title = <Stack.Screen options={{ title: 'Messaging settings' }} />;

  if (authState === 'loading' || (authState === 'in' && loading)) {
    return (
      <>
        {title}
        <View style={[styles.screen, styles.centerScreen]}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      </>
    );
  }

  if (authState === 'out') {
    return (
      <>
        {title}
        <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="chatbubbles" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Sign in to change messaging</Text>
            <Text style={styles.promptText}>
              These settings are only visible to signed-in admins.
            </Text>
          </View>
        </ScrollView>
      </>
    );
  }

  if (!isAdmin) {
    return (
      <>
        {title}
        <ScrollView style={styles.screen} contentContainerStyle={styles.container}>
          <View style={styles.centerCard}>
            <View style={styles.badge}>
              <Ionicons name="lock-closed" size={26} color={colors.ocean} />
            </View>
            <Text style={styles.promptTitle}>Admins only</Text>
            <Text style={styles.promptText}>
              The business number, business hours and saved texts are limited to owners and
              operators.
            </Text>
          </View>
        </ScrollView>
      </>
    );
  }

  const cellDirty = (profile?.cellPhone ?? '') !== cellDraft.trim();
  const cellInvalid =
    cellDraft.trim().length > 0 && profile?.cellPhone === cellDraft.trim() && !profile?.cellPhoneE164;

  return (
    <>
      {title}
      <ScrollView
        style={styles.screen}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled">
        {settings == null ? (
          <View style={styles.noticeCard}>
            <Ionicons name="warning" size={16} color={colors.coralDeep} />
            <Text style={styles.noticeText}>
              The messaging settings could not be read. The comms migration may not have been
              applied yet — see docs/TWILIO_SETUP.md.
            </Text>
          </View>
        ) : null}

        {/* ---- My cell -------------------------------------------------- */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>My cell number</Text>
          <Text style={styles.bodyText}>
            A bridge call rings this phone first, then dials the customer with the DC Solar number
            as the caller ID. Your own number is never shown to them.
          </Text>
          <TextInput
            value={cellDraft}
            onChangeText={setCellDraft}
            placeholder="e.g. (816) 555-0123"
            placeholderTextColor={colors.inkSoft}
            keyboardType="phone-pad"
            style={styles.input}
          />
          {profile?.cellPhoneE164 ? (
            <Text style={styles.hint}>Dials as {profile.cellPhoneE164}</Text>
          ) : cellInvalid ? (
            <Text style={styles.warnText}>
              That is not a US number we can dial — 10 digits, or 11 starting with 1.
            </Text>
          ) : null}
          <View style={styles.formButtons}>
            <Pressable
              onPress={() => void saveCell()}
              disabled={cellBusy || !cellDirty}
              style={({ pressed }) => [
                styles.saveButton,
                (pressed || cellBusy || !cellDirty) && styles.pressed,
              ]}>
              {cellBusy ? (
                <ActivityIndicator color={colors.ink} size="small" />
              ) : (
                <Text style={styles.saveButtonText}>Save number</Text>
              )}
            </Pressable>
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Bridge calling on my profile</Text>
            <Switch
              value={profile?.voiceBridgeEnabled !== false}
              onValueChange={(next) => void toggleBridge(next)}
              disabled={bridgeBusy}
              trackColor={{ false: colors.tan, true: colors.sun }}
              thumbColor={colors.white}
            />
          </View>
          <Pressable
            onPress={() => void sendTest()}
            disabled={testBusy}
            style={({ pressed }) => [styles.secondaryButton, (pressed || testBusy) && styles.pressed]}>
            {testBusy ? (
              <ActivityIndicator color={colors.ocean} size="small" />
            ) : (
              <>
                <Ionicons name="paper-plane" size={15} color={colors.ocean} />
                <Text style={styles.secondaryButtonText}>Send a test text to myself</Text>
              </>
            )}
          </Pressable>
        </View>

        {/* ---- Business number ------------------------------------------ */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>The DC Solar number</Text>
          <Text style={styles.fieldLabel}>Number customers see (E.164)</Text>
          <TextInput
            value={fromDraft}
            onChangeText={setFromDraft}
            placeholder="+18165550123"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="phone-pad"
            style={styles.input}
          />
          <Text style={styles.hint}>
            The purchased Twilio number. Leave it blank until the number exists — the edge functions
            fall back to TWILIO_FROM_NUMBER when it is set there instead.
          </Text>

          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Text messaging</Text>
            <Switch
              value={smsEnabled}
              onValueChange={setSmsEnabled}
              trackColor={{ false: colors.tan, true: colors.sun }}
              thumbColor={colors.white}
            />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Calling</Text>
            <Switch
              value={voiceEnabled}
              onValueChange={setVoiceEnabled}
              trackColor={{ false: colors.tan, true: colors.sun }}
              thumbColor={colors.white}
            />
          </View>
          <Text style={styles.hint}>
            Both stay off until the Twilio account, the number and the A2P campaign are live.
            Turning them on before that only changes which error you get.
          </Text>

          <Text style={styles.fieldLabel}>Business hours (America/Chicago)</Text>
          <View style={styles.hoursRow}>
            <TextInput
              value={hoursStart}
              onChangeText={setHoursStart}
              placeholder="07:00"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              style={[styles.input, styles.inputHalf]}
            />
            <Text style={styles.hoursDash}>to</Text>
            <TextInput
              value={hoursEnd}
              onChangeText={setHoursEnd}
              placeholder="18:00"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              style={[styles.input, styles.inputHalf]}
            />
          </View>

          <Text style={styles.fieldLabel}>After-hours auto-reply</Text>
          <TextInput
            value={autoreply}
            onChangeText={setAutoreply}
            placeholder="Sent automatically to anyone who texts outside those hours"
            placeholderTextColor={colors.inkSoft}
            multiline
            style={[styles.input, styles.inputMultiline]}
          />

          <Text style={styles.fieldLabel}>Review link</Text>
          <TextInput
            value={reviewLink}
            onChangeText={setReviewLink}
            placeholder="https://g.page/r/…"
            placeholderTextColor={colors.inkSoft}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Text style={styles.hint}>Fills the {'{{review_link}}'} field in the review template.</Text>

          <View style={styles.formButtons}>
            <Pressable
              onPress={() => void saveSettings()}
              disabled={settingsBusy}
              style={({ pressed }) => [
                styles.saveButton,
                (pressed || settingsBusy) && styles.pressed,
              ]}>
              {settingsBusy ? (
                <ActivityIndicator color={colors.ink} size="small" />
              ) : (
                <Text style={styles.saveButtonText}>Save settings</Text>
              )}
            </Pressable>
          </View>
        </View>

        {/* ---- Templates -------------------------------------------------- */}
        <View style={styles.card}>
          <View style={styles.cardHead}>
            <Text style={styles.cardTitle}>Saved texts</Text>
            <Pressable
              onPress={() => {
                setAdding((v) => !v);
                setEditingId(null);
              }}
              hitSlop={8}
              style={({ pressed }) => pressed && styles.pressed}>
              <Ionicons name={adding ? 'close' : 'add-circle'} size={20} color={colors.ocean} />
            </Pressable>
          </View>
          <Text style={styles.bodyText}>
            Merge fields look like {'{{customer_first}}'} and are filled in when you pick the
            template. Anything that cannot be filled is removed rather than sent as literal braces.
          </Text>

          {adding ? (
            <View style={styles.draftBox}>
              <Text style={styles.fieldLabel}>Key</Text>
              <TextInput
                value={draft.key}
                onChangeText={(v) => setDraft({ ...draft, key: v })}
                placeholder="on_my_way"
                placeholderTextColor={colors.inkSoft}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>Title</Text>
              <TextInput
                value={draft.title}
                onChangeText={(v) => setDraft({ ...draft, title: v })}
                placeholder="On my way"
                placeholderTextColor={colors.inkSoft}
                style={styles.input}
              />
              <Text style={styles.fieldLabel}>Text</Text>
              <TextInput
                value={draft.body}
                onChangeText={(v) => setDraft({ ...draft, body: v })}
                placeholder="DC Solar KC: … Reply STOP to opt out."
                placeholderTextColor={colors.inkSoft}
                multiline
                style={[styles.input, styles.inputMultiline]}
              />
              {draft.body.trim().length > 0 && !STOP_SENTENCE.test(draft.body) ? (
                <Text style={styles.warnText}>
                  This does not end with &quot;Reply STOP to opt out.&quot; — that sentence is part
                  of the A2P campaign registration.
                </Text>
              ) : null}
              <View style={styles.formButtons}>
                <Pressable
                  onPress={() => {
                    setAdding(false);
                    setDraft(EMPTY_DRAFT);
                  }}
                  style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={() => void saveNew()}
                  disabled={templateBusy}
                  style={({ pressed }) => [
                    styles.saveButton,
                    (pressed || templateBusy) && styles.pressed,
                  ]}>
                  <Text style={styles.saveButtonText}>Add</Text>
                </Pressable>
              </View>
            </View>
          ) : null}

          {templates.length === 0 ? (
            <Text style={styles.emptyText}>No saved texts yet.</Text>
          ) : (
            templates.map((template, index) => {
              const editing = editingId === template.id;
              return (
                <View
                  key={template.id}
                  style={[styles.templateRow, index > 0 && styles.rowBorderTop]}>
                  <View style={styles.templateHead}>
                    <Text style={styles.templateTitle} numberOfLines={1}>
                      {template.title}
                    </Text>
                    {!template.active ? (
                      <View style={styles.offChip}>
                        <Text style={styles.offChipText}>Off</Text>
                      </View>
                    ) : null}
                    <Pressable
                      onPress={() => (editing ? setEditingId(null) : startEdit(template))}
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Ionicons
                        name={editing ? 'close' : 'pencil'}
                        size={15}
                        color={colors.inkSoft}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => void toggleActive(template)}
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Ionicons
                        name={template.active ? 'eye' : 'eye-off'}
                        size={15}
                        color={colors.inkSoft}
                      />
                    </Pressable>
                    <Pressable
                      onPress={() => void pressDelete(template)}
                      hitSlop={6}
                      style={({ pressed }) => pressed && styles.pressed}>
                      <Ionicons
                        name="trash"
                        size={15}
                        color={confirmDeleteId === template.id ? colors.danger : colors.inkSoft}
                      />
                    </Pressable>
                  </View>
                  {editing ? (
                    <>
                      <TextInput
                        value={editTitle}
                        onChangeText={setEditTitle}
                        style={styles.input}
                        placeholder="Title"
                        placeholderTextColor={colors.inkSoft}
                      />
                      <TextInput
                        value={editBody}
                        onChangeText={setEditBody}
                        multiline
                        style={[styles.input, styles.inputMultiline]}
                        placeholder="Text"
                        placeholderTextColor={colors.inkSoft}
                      />
                      <Text style={styles.fieldLabel}>Order</Text>
                      <TextInput
                        value={editSort}
                        onChangeText={setEditSort}
                        keyboardType="number-pad"
                        style={[styles.input, styles.inputHalf]}
                      />
                      {editBody.trim().length > 0 && !STOP_SENTENCE.test(editBody) ? (
                        <Text style={styles.warnText}>
                          This does not end with &quot;Reply STOP to opt out.&quot; — that sentence
                          is part of the A2P campaign registration.
                        </Text>
                      ) : null}
                      <View style={styles.formButtons}>
                        <Pressable
                          onPress={() => setEditingId(null)}
                          style={({ pressed }) => [styles.cancelButton, pressed && styles.pressed]}>
                          <Text style={styles.cancelButtonText}>Cancel</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => void saveEdit()}
                          disabled={templateBusy}
                          style={({ pressed }) => [
                            styles.saveButton,
                            (pressed || templateBusy) && styles.pressed,
                          ]}>
                          <Text style={styles.saveButtonText}>Save</Text>
                        </Pressable>
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={styles.templateBody}>{template.body}</Text>
                      <Text style={styles.hint}>
                        Preview: {renderTemplate(template.body, {
                          customer_first: 'Sam',
                          customer_name: 'Sam Rivera',
                          address: '123 Maple St',
                          job_number: 'DC-26012',
                          tech: role?.displayName ?? 'Devon',
                          review_link: settings?.reviewLink ?? null,
                        })}
                      </Text>
                    </>
                  )}
                  {confirmDeleteId === template.id ? (
                    <Text style={styles.confirmHint}>Tap the trash again to delete.</Text>
                  ) : null}
                </View>
              );
            })
          )}
        </View>

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
  screen: { flex: 1, backgroundColor: colors.cream },
  centerScreen: { alignItems: 'center', justifyContent: 'center' },
  container: { padding: spacing.lg, gap: spacing.md, paddingBottom: spacing.xxl },

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
  promptTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  promptText: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.coralSoft,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  noticeText: { flex: 1, color: colors.inkSoft, fontSize: 13, fontWeight: '600' },

  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
    ...shadows.card,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  cardTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '800' },
  bodyText: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  emptyText: { color: colors.inkSoft, fontSize: 13, fontWeight: '600' },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  warnText: { color: colors.coralDeep, fontSize: 12, fontWeight: '700' },
  confirmHint: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  fieldLabel: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    marginTop: spacing.sm,
  },
  input: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
  },
  inputMultiline: { minHeight: 84, textAlignVertical: 'top' },
  inputHalf: { flex: 1 },
  hoursRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  hoursDash: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },

  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  switchLabel: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '700' },

  formButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  saveButton: {
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
    minWidth: 110,
    alignItems: 'center',
  },
  saveButtonText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  cancelButton: {
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  cancelButtonText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.skySoft,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
    marginTop: spacing.sm,
  },
  secondaryButtonText: { color: colors.ocean, fontSize: 13, fontWeight: '800' },

  draftBox: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.sm,
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  templateRow: { paddingTop: spacing.sm, gap: spacing.xs },
  rowBorderTop: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
    marginTop: spacing.sm,
  },
  templateHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  templateTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '800' },
  templateBody: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  offChip: {
    backgroundColor: colors.slateSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 1,
  },
  offChipText: { color: colors.slateDeep, fontSize: 10, fontWeight: '800' },

  statusText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  statusError: { color: colors.danger },
  statusSuccess: { color: colors.success },
  pressed: { opacity: 0.6 },
});
