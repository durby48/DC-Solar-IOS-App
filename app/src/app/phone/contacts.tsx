import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { Chip } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_VOICE,
  archiveContact,
  createContact,
  fetchCommsSettings,
  fetchDirectory,
  fetchMyStaffProfile,
  formatPhone,
  placeBridgeCall,
  type CommsSettings,
  type DirectoryEntry,
  type DirectorySource,
  type StaffProfile,
} from '@/lib/comms';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * Phone → Contacts. Everybody the crew dials, A–Z, from `phone_directory()`.
 *
 * FOUR SOURCES, ONE LIST. Customers, leads, the crew and suppliers come back
 * from one server-side function already sorted and de-duplicated by handset,
 * so this screen does no merging of its own — it sections by first letter,
 * filters, and searches. The filter chips are a lens over one list, not four
 * different queries.
 *
 * A RECORD WITH NO USABLE NUMBER IS SHOWN, GREYED, WITH THE REASON. Silently
 * hiding a customer because somebody typed their number wrong is worse than
 * showing that they can't be dialled.
 *
 * SUPPLIERS ARE ADDED HERE. Phase 1 built the `contacts` table and nobody but
 * Devon knows what belongs in it, so the form lives on this tab rather than
 * in a settings screen he would have to go looking for.
 */

type Filter = 'all' | DirectorySource;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'customer', label: 'Customers' },
  { key: 'lead', label: 'Leads' },
  { key: 'crew', label: 'Crew' },
  { key: 'contact', label: 'Suppliers' },
];

const SOURCE_LABEL: Record<DirectorySource, string> = {
  customer: 'Customer',
  lead: 'Lead',
  crew: 'Crew',
  contact: 'Supplier',
};

const KINDS = ['supplier', 'vendor', 'inspector', 'other'] as const;

function sectionLetter(entry: DirectoryEntry): string {
  const first = entry.sortKey.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

export default function ContactsScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [callingKey, setCallingKey] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  // Add-supplier form.
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', org: '', phone: '', email: '', kind: 'supplier' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [rows, s, p] = await Promise.all([
      fetchDirectory(),
      fetchCommsSettings(),
      fetchMyStaffProfile(),
    ]);
    setDirectory(rows);
    setSettings(s);
    setProfile(p);
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    const rows = directory.filter((entry) => {
      if (entry.archived) return false;
      if (filter !== 'all' && entry.source !== filter) return false;
      if (!q) return true;
      if (entry.displayName.toLowerCase().includes(q)) return true;
      if (entry.subtitle?.toLowerCase().includes(q)) return true;
      if (qDigits.length >= 3 && entry.phoneE164?.includes(qDigits)) return true;
      return false;
    });
    const byLetter = new Map<string, DirectoryEntry[]>();
    for (const entry of rows) {
      const letter = sectionLetter(entry);
      const list = byLetter.get(letter) ?? [];
      list.push(entry);
      byLetter.set(letter, list);
    }
    return [...byLetter.entries()]
      .sort(([a], [b]) => (a === '#' ? 1 : b === '#' ? -1 : a.localeCompare(b)))
      .map(([title, data]) => ({ title, data }));
  }, [directory, search, filter]);

  const voiceReady = settings?.voiceEnabled === true;
  const hasStaffNumber = Boolean(profile?.cellPhoneE164);
  const canCall = voiceReady && hasStaffNumber;

  const keyOf = (entry: DirectoryEntry) => `${entry.source}:${entry.id}`;

  const call = async (entry: DirectoryEntry) => {
    if (!entry.phoneE164 || callingKey) return;
    if (voiceReady && inAppCallingSupported()) {
      const callParams: Record<string, string> = { to: entry.phoneE164, name: entry.displayName };
      if (entry.source === 'customer') callParams.customerId = entry.id;
      else if (entry.source === 'contact') callParams.contactId = entry.id;
      router.push({ pathname: '/call', params: callParams } as never);
      return;
    }
    if (!canCall) {
      // Every call goes through Twilio, and Twilio rings your cell first. No
      // cell saved → the keypad asks for it once; send them there.
      setNote({
        kind: 'error',
        text: !voiceReady
          ? NOT_CONFIGURED_VOICE
          : 'Twilio rings your cell first — tap Call on the Keypad once to save it, or add it in Messages settings.',
      });
      return;
    }
    setCallingKey(keyOf(entry));
    setNote({ kind: 'info', text: `Ringing your cell, then ${entry.displayName}…` });
    const result = await placeBridgeCall({
      customerId: entry.source === 'customer' ? entry.id : undefined,
      contactId: entry.source === 'contact' ? entry.id : undefined,
      to: entry.source === 'customer' || entry.source === 'contact' ? undefined : entry.phoneE164,
    });
    setCallingKey(null);
    setNote(
      result.ok
        ? { kind: 'ok', text: 'Pick up your phone — we are dialling them next.' }
        : { kind: 'error', text: result.message },
    );
  };

  const openRecord = (entry: DirectoryEntry) => {
    if (entry.source === 'customer') {
      router.push({ pathname: '/crm/[id]', params: { id: entry.id } });
    } else if (entry.source === 'lead') {
      router.push({ pathname: '/leads/[id]', params: { id: entry.id } } as never);
    }
  };

  /** The conversation screen, like tapping "message" on a phone contact. */
  const openThread = (entry: DirectoryEntry) => {
    if (!entry.phoneE164) return;
    const params: Record<string, string> = { phone: entry.phoneE164, name: entry.displayName };
    if (entry.source === 'customer') params.customerId = entry.id;
    else if (entry.source === 'contact') params.contactId = entry.id;
    else if (entry.source === 'lead') params.leadId = entry.id;
    router.push({ pathname: '/messages/thread', params } as never);
  };

  const saveContact = async () => {
    setFormError(null);
    if (!form.name.trim()) {
      setFormError('Give them a name.');
      return;
    }
    setSaving(true);
    const result = await createContact({
      name: form.name,
      org: form.org,
      phone: form.phone,
      email: form.email,
      kind: form.kind,
    });
    setSaving(false);
    if (result.ok) {
      setAdding(false);
      setForm({ name: '', org: '', phone: '', email: '', kind: 'supplier' });
      setFilter('contact');
      await load();
    } else {
      setFormError(result.message);
    }
  };

  const archive = async (entry: DirectoryEntry) => {
    const result = await archiveContact(entry.id);
    if (result.ok) {
      setOpenKey(null);
      await load();
    } else {
      setNote({ kind: 'error', text: result.message });
    }
  };

  const renderEntry = ({ item }: { item: DirectoryEntry }) => {
    const key = keyOf(item);
    const open = openKey === key;
    const dialable = Boolean(item.phoneE164);
    const hasRecord = item.source === 'customer' || item.source === 'lead';
    return (
      <View>
        <Pressable
          onPress={() => {
            setOpenKey(open ? null : key);
            setNote(null);
          }}
          style={({ pressed }) => [styles.row, !dialable && styles.rowMuted, pressed && styles.rowPressed]}>
          <CustomerAvatar customer={{ id: item.id, name: item.displayName }} size={36} url={null} />
          <View style={styles.rowBody}>
            <Text style={[styles.rowName, !dialable && styles.textMuted]} numberOfLines={1}>
              {item.displayName}
            </Text>
            <Text style={styles.rowMeta} numberOfLines={1}>
              {SOURCE_LABEL[item.source]}
              {item.subtitle ? ` · ${item.subtitle}` : ''}
            </Text>
            <Text style={[styles.rowPhone, !dialable && styles.rowPhoneMissing]} numberOfLines={1}>
              {dialable
                ? formatPhone(item.phoneE164)
                : item.source === 'crew'
                  ? 'No cell number saved in Messages settings'
                  : 'No usable US number on the record'}
            </Text>
          </View>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
        </Pressable>

        {open ? (
          <View style={styles.sheet}>
            <View style={styles.actions}>
              <Pressable
                onPress={() => void call(item)}
                disabled={!dialable || callingKey !== null}
                style={({ pressed }) => [
                  styles.action,
                  !dialable && styles.actionMuted,
                  pressed && styles.pressed,
                ]}>
                {callingKey === key ? (
                  <ActivityIndicator color={colors.ink} size="small" />
                ) : (
                  <Ionicons name="call" size={16} color={colors.ink} />
                )}
                <Text style={styles.actionLabel}>Call</Text>
              </Pressable>
              <Pressable
                onPress={() => openThread(item)}
                disabled={!dialable}
                style={({ pressed }) => [
                  styles.action,
                  styles.actionSecondary,
                  !dialable && styles.actionMuted,
                  pressed && styles.pressed,
                ]}>
                <Ionicons name="chatbubble" size={16} color={colors.ocean} />
                <Text style={[styles.actionLabel, styles.actionLabelSecondary]}>Text</Text>
              </Pressable>
              {hasRecord ? (
                <Pressable
                  onPress={() => openRecord(item)}
                  style={({ pressed }) => [styles.action, styles.actionSecondary, pressed && styles.pressed]}>
                  <Ionicons name="open-outline" size={16} color={colors.ocean} />
                  <Text style={[styles.actionLabel, styles.actionLabelSecondary]}>Record</Text>
                </Pressable>
              ) : null}
            </View>
            {!dialable ? (
              <Text style={styles.hint}>
                {item.source === 'crew'
                  ? 'They add it themselves under Messages settings → My cell number.'
                  : hasRecord
                    ? 'Fix the phone number on their record and it will dial from here.'
                    : 'Edit the number on this contact to make it dialable.'}
              </Text>
            ) : null}
            {item.source === 'contact' ? (
              <Pressable
                onPress={() => void archive(item)}
                style={({ pressed }) => [styles.archive, pressed && styles.pressed]}>
                <Ionicons name="archive-outline" size={14} color={colors.inkSoft} />
                <Text style={styles.archiveText}>Remove from contacts</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  const addForm = adding ? (
    <View style={styles.form}>
      <Text style={styles.formTitle}>New supplier</Text>
      <TextInput
        value={form.name}
        onChangeText={(name) => setForm((f) => ({ ...f, name }))}
        placeholder="Name (person, or the business)"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <TextInput
        value={form.org}
        onChangeText={(org) => setForm((f) => ({ ...f, org }))}
        placeholder="Company, e.g. Kansas City Solar Supply"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <TextInput
        value={form.phone}
        onChangeText={(phone) => setForm((f) => ({ ...f, phone }))}
        placeholder="Phone"
        placeholderTextColor={colors.inkSoft}
        keyboardType="phone-pad"
        style={styles.input}
      />
      <TextInput
        value={form.email}
        onChangeText={(email) => setForm((f) => ({ ...f, email }))}
        placeholder="Email (optional)"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        keyboardType="email-address"
        style={styles.input}
      />
      <View style={styles.kinds}>
        {KINDS.map((kind) => (
          <Chip
            key={kind}
            label={kind.charAt(0).toUpperCase() + kind.slice(1)}
            tone="olive"
            selected={form.kind === kind}
            onPress={() => setForm((f) => ({ ...f, kind }))}
          />
        ))}
      </View>
      {formError ? <Text style={styles.formError}>{formError}</Text> : null}
      <View style={styles.formButtons}>
        <Pressable
          onPress={() => {
            setAdding(false);
            setFormError(null);
          }}
          style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => void saveContact()}
          disabled={saving}
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Text style={styles.saveText}>Save</Text>
          )}
        </Pressable>
      </View>
    </View>
  ) : null;

  const header = (
    <View style={styles.headerArea}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.inkSoft} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, address, company or number"
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
      <View style={styles.filters}>
        {FILTERS.map((option) => (
          <Chip
            key={option.key}
            label={option.label}
            tone="ocean"
            selected={filter === option.key}
            onPress={() => setFilter(option.key)}
          />
        ))}
      </View>
      {!adding ? (
        <Pressable
          onPress={() => setAdding(true)}
          style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
          <Ionicons name="add" size={16} color={colors.ocean} />
          <Text style={styles.addButtonText}>Add a supplier</Text>
        </Pressable>
      ) : null}
      {addForm}
      {note ? (
        <Text
          style={[
            styles.note,
            note.kind === 'error' ? styles.noteError : note.kind === 'ok' ? styles.noteOk : null,
          ]}>
          {note.text}
        </Text>
      ) : null}
    </View>
  );

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  return (
    <SectionList
      style={styles.screen}
      contentContainerStyle={styles.container}
      sections={sections}
      keyExtractor={(item) => keyOf(item)}
      renderItem={renderEntry}
      renderSectionHeader={({ section }) => (
        <Text style={styles.sectionTitle}>{section.title}</Text>
      )}
      ListHeaderComponent={header}
      ItemSeparatorComponent={() => <View style={styles.separator} />}
      stickySectionHeadersEnabled={false}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
      }
      ListEmptyComponent={
        <View style={styles.emptyCard}>
          <Ionicons name="people-outline" size={22} color={colors.inkSoft} />
          <Text style={styles.emptyTitle}>
            {search || filter !== 'all' ? 'Nobody matches' : 'No contacts yet'}
          </Text>
          <Text style={styles.emptyBody}>
            {search || filter !== 'all'
              ? 'Try a different filter or a shorter search.'
              : 'Customers, leads, the crew and suppliers all show up here once they have a record.'}
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  center: { alignItems: 'center', justifyContent: 'center' },
  container: { padding: spacing.lg, paddingBottom: spacing.xxl },
  headerArea: { gap: spacing.sm, paddingBottom: spacing.sm },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.line,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '500', paddingVertical: 4 },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  addButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  addButtonText: { color: colors.ocean, fontSize: 13, fontWeight: '800' },
  note: { fontSize: 13, fontWeight: '700', color: colors.ocean },
  noteOk: { color: colors.success },
  noteError: { color: colors.danger },
  sectionTitle: {
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0.7,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    ...shadows.card,
  },
  rowMuted: { opacity: 0.6 },
  rowPressed: { backgroundColor: colors.skySoft },
  separator: { height: spacing.sm },
  rowBody: { flex: 1, gap: 1 },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  textMuted: { color: colors.inkSoft },
  rowMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  rowPhone: { color: colors.ocean, fontSize: 12, fontWeight: '700' },
  rowPhoneMissing: { color: colors.slateDeep, fontStyle: 'italic', fontWeight: '600' },

  sheet: {
    backgroundColor: colors.canvas,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    marginTop: spacing.xs,
    padding: spacing.sm,
    gap: spacing.sm,
  },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm + 2,
  },
  actionSecondary: { backgroundColor: colors.white },
  actionMuted: { opacity: 0.45 },
  actionLabel: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  actionLabelSecondary: { color: colors.ocean },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  archive: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, alignSelf: 'flex-start' },
  archiveText: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },

  form: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  formTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  input: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
  },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  formError: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  formButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 14, fontWeight: '700' },
  save: {
    backgroundColor: colors.sun,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radii.pill,
    minWidth: 72,
    alignItems: 'center',
  },
  saveText: { color: colors.ink, fontSize: 14, fontWeight: '800' },

  emptyCard: {
    backgroundColor: colors.skySoft,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  pressed: { opacity: 0.6 },
});
