import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';

import {
  deviceContactsSupported,
  readDeviceContacts,
  type DeviceContact,
} from './deviceContacts';

/** Enough to find someone by search; the list never renders thousands of rows. */
const SHOW_LIMIT = 60;

/**
 * Pick ONE contact from the iPhone's address book (Build 33).
 *
 * Inline, not a modal: it is shown inside an `EditorSheet` in place of the
 * form, so there is never a modal on top of a modal and never a FlatList
 * nested in the sheet's ScrollView. Search narrows the list; the first
 * SHOW_LIMIT matches are drawn.
 *
 * PRIVACY. The address book is read on the phone, only after the person taps
 * "Import from iPhone", and nothing leaves the phone here — the caller gets
 * the one contact that was tapped and saves only the fields it needs.
 *
 * PERMISSION STATES: first ask (iOS prompt) → granted / limited (iOS 18
 * "Select contacts" — only shared contacts are listed, with a way to share
 * more) / denied (a Settings button). Coming back from Settings re-reads
 * automatically, so turning access on there works without closing the sheet.
 * Every state keeps a Cancel, and manual entry is always one tap away.
 */
export function DeviceContactPicker({
  onPick,
  onCancel,
}: {
  onPick: (contact: DeviceContact) => void;
  onCancel: () => void;
}) {
  const supported = deviceContactsSupported();
  const [state, setState] = useState<
    | { kind: 'reading' }
    | { kind: 'ok'; contacts: DeviceContact[]; limited: boolean }
    | { kind: 'denied'; canAskAgain: boolean }
    | { kind: 'error'; message: string }
    | { kind: 'unsupported' }
  >(supported ? { kind: 'reading' } : { kind: 'unsupported' });
  const [search, setSearch] = useState('');
  const sentToSettings = useRef(false);

  const read = useCallback(async () => {
    if (!supported) return;
    setState({ kind: 'reading' });
    const answer = await readDeviceContacts();
    if (answer.status === 'ok') setState({ kind: 'ok', contacts: answer.contacts, limited: answer.limited });
    else if (answer.status === 'denied') setState({ kind: 'denied', canAskAgain: answer.canAskAgain });
    else if (answer.status === 'unsupported') setState({ kind: 'unsupported' });
    else setState({ kind: 'error', message: answer.message });
  }, [supported]);

  useEffect(() => {
    void read();
  }, [read]);

  // Back from Settings: read again, so a newly granted permission shows up.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active' && sentToSettings.current) {
        sentToSettings.current = false;
        void read();
      }
    });
    return () => sub.remove();
  }, [read]);

  const openSettings = () => {
    sentToSettings.current = true;
    void Linking.openSettings();
  };

  const matches = useMemo(() => {
    if (state.kind !== 'ok') return [];
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    const list = !q
      ? state.contacts
      : state.contacts.filter(
          (c) =>
            c.name.toLowerCase().includes(q) ||
            (c.org?.toLowerCase().includes(q) ?? false) ||
            (qDigits.length >= 3 && c.phones.some((p) => p.replace(/[^0-9]/g, '').includes(qDigits))) ||
            c.emails.some((e) => e.includes(q)),
        );
    return list.slice(0, SHOW_LIMIT);
  }, [state, search]);

  const cancelRow = (
    <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
      <Text style={styles.cancelText}>Back to the form</Text>
    </Pressable>
  );

  if (state.kind === 'unsupported') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.body}>
          The iPhone address book is not available here (the web app, or an older build). Type the
          details in instead.
        </Text>
        {cancelRow}
      </View>
    );
  }

  if (state.kind === 'reading') {
    return (
      <View style={[styles.wrap, styles.center]}>
        <ActivityIndicator color={hubColors.crm.fg} />
        <Text style={styles.body}>Reading your iPhone contacts…</Text>
      </View>
    );
  }

  if (state.kind === 'denied' || state.kind === 'error') {
    return (
      <View style={styles.wrap}>
        <Text style={styles.body}>
          {state.kind === 'error'
            ? state.message
            : 'DC Solar does not have access to your contacts. Turn it on in Settings → DC Solar → Contacts, then come back here. You can always type the details in instead.'}
        </Text>
        <View style={styles.buttons}>
          {cancelRow}
          {state.kind === 'denied' ? (
            <Pressable onPress={openSettings} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>Open Settings</Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => void read()} style={({ pressed }) => [styles.primary, pressed && styles.pressed]}>
              <Text style={styles.primaryText}>Try again</Text>
            </Pressable>
          )}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      {state.limited ? (
        <View style={styles.limited}>
          <Text style={styles.limitedText}>
            Only the contacts you chose to share are listed.
          </Text>
          <Pressable onPress={openSettings} hitSlop={6}>
            <Text style={styles.link}>Share more</Text>
          </Pressable>
        </View>
      ) : null}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.inkSoft} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search your iPhone contacts"
          placeholderTextColor={colors.inkSoft}
          autoCorrect={false}
          autoCapitalize="none"
          style={styles.searchInput}
        />
      </View>
      {matches.length === 0 ? (
        <Text style={styles.body}>
          {state.contacts.length === 0 ? 'No contacts are visible on this iPhone.' : 'Nobody matches that search.'}
        </Text>
      ) : (
        <View style={styles.list}>
          {matches.map((c, index) => (
            <Pressable
              key={c.id}
              onPress={() => onPick(c)}
              accessibilityRole="button"
              accessibilityLabel={`Use ${c.name}`}
              style={({ pressed }) => [styles.row, index > 0 && styles.divided, pressed && styles.rowPressed]}>
              <View style={styles.rowBody}>
                <Text style={styles.rowName} numberOfLines={1}>
                  {c.name}
                </Text>
                <Text style={styles.rowMeta} numberOfLines={1}>
                  {[c.phones[0], c.org, c.emails[0]].filter(Boolean).join(' · ') || 'No number or email'}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.inkSoft} />
            </Pressable>
          ))}
        </View>
      )}
      {state.contacts.length > SHOW_LIMIT && !search ? (
        <Text style={styles.hint}>Showing the first {SHOW_LIMIT} — search to find anyone else.</Text>
      ) : null}
      {cancelRow}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  center: { alignItems: 'center', paddingVertical: spacing.lg },
  body: { color: colors.textSecondary, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  hint: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  limited: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.skySoft,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  limitedText: { flex: 1, color: colors.textSecondary, fontSize: 12, fontWeight: '600' },
  link: { color: colors.accentLink, fontSize: 12, fontWeight: '800' },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  searchInput: { flex: 1, color: colors.textPrimary, fontSize: 15, paddingVertical: spacing.xs },
  list: { borderRadius: radii.sm, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surface,
  },
  rowPressed: { backgroundColor: hubColors.crm.bg },
  divided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  rowBody: { flex: 1, gap: 1 },
  rowName: { color: colors.textPrimary, fontSize: 15, fontWeight: '700' },
  rowMeta: { color: colors.textSecondary, fontSize: 12, fontWeight: '500' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.pill, alignSelf: 'flex-start' },
  cancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  primary: {
    backgroundColor: colors.sun,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
  },
  primaryText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
