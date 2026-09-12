import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ContactEditor } from '@/components/contacts/ContactEditor';
import { CustomerEditor } from '@/components/contacts/CustomerEditor';
import { deviceContactsSupported } from '@/components/contacts/deviceContacts';
import { EditorSheet } from '@/components/contacts/EditorSheet';
import { MyCellEditor } from '@/components/contacts/MyCellEditor';
import { CustomerAvatar } from '@/components/CustomerAvatar';
import { Chip } from '@/components/ui';
import { colors, hubColors, radii, shadows, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_VOICE,
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
import {
  archiveContact,
  collectTags,
  fetchContacts,
  tagLabel,
  type CompanyContact,
} from '@/lib/contacts';
import { useRole } from '@/lib/role';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * Phone → Contacts. Everybody the crew dials, A–Z, from `phone_directory()`.
 *
 * FOUR SOURCES, ONE LIST. Customers, leads, the crew and company contacts
 * come back from one server-side function already sorted and de-duplicated
 * by handset, so this screen does no merging of its own — it sections by
 * first letter, filters, and searches. The filter chips are a lens over one
 * list, not four different queries.
 *
 * TAGS ARE THE SECOND ROW OF CHIPS (2026-09-12). A company contact carries
 * free-form tags — distributor, driver, city inspector — and every tag in
 * use becomes a chip next to the four sources. Filtering by a tag is the
 * same lens: `entry.tags.includes(tag)`.
 *
 * A RECORD WITH NO USABLE NUMBER IS SHOWN, GREYED, WITH THE REASON. Silently
 * hiding a customer because somebody typed their number wrong is worse than
 * showing that they can't be dialled.
 *
 * EVERY ROW IS EDITABLE FROM HERE (2026-09-12, the owner's ask: "edit the
 * contact card from directly within the contacts section"). An admin sees
 * an "Edit" pill on the right of every row that has something to edit, and
 * the same Edit inside the expanded card. What opens depends on the source:
 *
 *   contact   → `ContactEditor` (name, company, title, phone, email, tags,
 *               customer link, notes) in a bottom sheet.
 *   customer  → `CustomerEditor` (name, phone, email, address, notes) — the
 *               same fields and the same `updateCustomer` as the record.
 *   lead      → the lead's own screen, /leads/[id], where its editor lives.
 *   crew      → only YOUR OWN cell number (`staff_profiles` is self-write);
 *               another person's row is read-only.
 *
 * The crew (non-admins) get the read-only card — Call / Text / Record — and
 * no Edit anywhere; RLS refuses the write regardless.
 */

type Filter = 'all' | DirectorySource | `tag:${string}`;

/** What the sheet is editing, or null when closed. */
type Editor =
  | { kind: 'new' }
  | { kind: 'contact'; contact: CompanyContact }
  | { kind: 'customer'; id: string; name: string }
  | { kind: 'myCell' };

const SOURCE_FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'customer', label: 'Customers' },
  { key: 'lead', label: 'Leads' },
  { key: 'crew', label: 'Crew' },
  { key: 'contact', label: 'Contacts' },
];

const SOURCE_LABEL: Record<DirectorySource, string> = {
  customer: 'Customer',
  lead: 'Lead',
  crew: 'Crew',
  contact: 'Contact',
};

function sectionLetter(entry: DirectoryEntry): string {
  const first = entry.sortKey.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(first) ? first : '#';
}

export default function ContactsScreen() {
  const router = useRouter();
  const role = useRole();
  const isAdmin = role?.isAdmin === true;
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [contacts, setContacts] = useState<Map<string, CompanyContact>>(() => new Map());
  const [settings, setSettings] = useState<CommsSettings | null>(null);
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [callingKey, setCallingKey] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  const load = useCallback(async () => {
    const [rows, contactRows, s, p] = await Promise.all([
      fetchDirectory(),
      fetchContacts(),
      fetchCommsSettings(),
      fetchMyStaffProfile(),
    ]);
    setDirectory(rows);
    setContacts(new Map(contactRows.map((c) => [c.id, c])));
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

  /** Customer names by id, so a filed contact's row can say "at Cromwell". */
  const customerNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of directory) if (entry.source === 'customer') map.set(entry.id, entry.displayName);
    return map;
  }, [directory]);

  const tagChips = useMemo(() => collectTags([...contacts.values()]), [contacts]);

  const sections = useMemo(() => {
    const q = search.trim().toLowerCase();
    const qDigits = q.replace(/[^0-9]/g, '');
    const tagFilter = filter.startsWith('tag:') ? filter.slice(4) : null;
    const rows = directory.filter((entry) => {
      if (entry.archived) return false;
      if (tagFilter) {
        if (entry.source !== 'contact' || !entry.tags.includes(tagFilter)) return false;
      } else if (filter !== 'all' && entry.source !== filter) {
        return false;
      }
      if (!q) return true;
      if (entry.displayName.toLowerCase().includes(q)) return true;
      if (entry.subtitle?.toLowerCase().includes(q)) return true;
      if (entry.title?.toLowerCase().includes(q)) return true;
      if (entry.tags.some((t) => t.includes(q))) return true;
      if (entry.customerId && customerNames.get(entry.customerId)?.toLowerCase().includes(q)) return true;
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
  }, [directory, search, filter, customerNames]);

  const voiceReady = settings?.voiceEnabled === true;
  const hasStaffNumber = Boolean(profile?.cellPhoneE164);
  const canCall = voiceReady && hasStaffNumber;

  const keyOf = (entry: DirectoryEntry) => `${entry.source}:${entry.id}`;

  /**
   * Is this crew row me? `phone_directory()` names a crew row
   * `coalesce(employees.display_name, employees.email)` and carries no
   * email, so the match is on that same string from my own role row.
   */
  const isMe = (entry: DirectoryEntry) =>
    entry.source === 'crew' &&
    role !== null &&
    entry.displayName === (role.displayName?.trim() || role.email);

  /** The editor a row opens, or null when there is nothing to edit here. */
  const editorFor = (entry: DirectoryEntry): Editor | 'lead' | null => {
    if (!isAdmin) return null;
    switch (entry.source) {
      case 'contact': {
        const contact = contacts.get(entry.id);
        return contact ? { kind: 'contact', contact } : null;
      }
      case 'customer':
        return { kind: 'customer', id: entry.id, name: entry.displayName };
      case 'lead':
        return 'lead';
      case 'crew':
        return isMe(entry) ? { kind: 'myCell' } : null;
      default:
        return null;
    }
  };

  const openEditor = (entry: DirectoryEntry) => {
    const target = editorFor(entry);
    if (!target) return;
    setNote(null);
    if (target === 'lead') {
      router.push({ pathname: '/leads/[id]', params: { id: entry.id } } as never);
      return;
    }
    setOpenKey(null);
    setEditor(target);
  };

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
          : 'Twilio rings your cell first — tap Call on the Keypad once and it asks for your number.',
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
    } else if (entry.source === 'contact' && entry.customerId) {
      router.push({ pathname: '/crm/[id]', params: { id: entry.customerId, segment: 'contacts' } });
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

  const archive = async (entry: DirectoryEntry) => {
    const result = await archiveContact(entry.id);
    if (result.ok) {
      setOpenKey(null);
      await load();
    } else {
      setNote({ kind: 'error', text: result.message });
    }
  };

  const onSaved = async (text: string) => {
    setEditor(null);
    setNote({ kind: 'ok', text });
    await load();
  };

  const renderEntry = ({ item }: { item: DirectoryEntry }) => {
    const key = keyOf(item);
    const open = openKey === key;
    const dialable = Boolean(item.phoneE164);
    const filedUnder = item.customerId ? customerNames.get(item.customerId) : undefined;
    const hasRecord = item.source === 'customer' || item.source === 'lead' || Boolean(filedUnder);
    const editable = editorFor(item) !== null;
    const mine = isMe(item);
    const meta = [
      SOURCE_LABEL[item.source],
      mine ? 'you' : null,
      item.title,
      item.subtitle,
      filedUnder ? `at ${filedUnder}` : null,
    ]
      .filter((part) => part && part.trim().length > 0)
      .join(' · ');

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
              {meta}
            </Text>
            <Text style={[styles.rowPhone, !dialable && styles.rowPhoneMissing]} numberOfLines={1}>
              {dialable
                ? formatPhone(item.phoneE164)
                : item.source === 'crew'
                  ? 'No cell number saved'
                  : 'No usable US number on the record'}
            </Text>
            {item.tags.length ? (
              <View style={styles.tags}>
                {item.tags.map((tag) => (
                  <Chip key={tag} label={tagLabel(tag)} tone="neutral" />
                ))}
              </View>
            ) : null}
          </View>
          {editable ? (
            <Pressable
              onPress={() => openEditor(item)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`Edit ${item.displayName}`}
              style={({ pressed }) => [styles.editPill, pressed && styles.pressed]}>
              <Ionicons name="create-outline" size={14} color={hubColors.crm.fg} />
              <Text style={styles.editPillText}>Edit</Text>
            </Pressable>
          ) : (
            <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
          )}
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
                  <Text style={[styles.actionLabel, styles.actionLabelSecondary]}>
                    {filedUnder ? 'Customer' : 'Record'}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {!dialable ? (
              <Text style={styles.hint}>
                {item.source === 'crew'
                  ? mine
                    ? 'Add your cell number with Edit — it is the phone we ring first.'
                    : 'They add it themselves: their first Call on the Keypad asks for it.'
                  : editable
                    ? 'Tap Edit and fix the number to make it dialable.'
                    : 'Fix the phone number on their record and it will dial from here.'}
              </Text>
            ) : null}
            {isAdmin && (editable || item.source === 'contact') ? (
              <View style={styles.manageRow}>
                {editable ? (
                  <Pressable
                    onPress={() => openEditor(item)}
                    style={({ pressed }) => [styles.manage, pressed && styles.pressed]}>
                    <Ionicons name="create-outline" size={14} color={colors.ocean} />
                    <Text style={styles.manageText}>
                      {item.source === 'lead'
                        ? 'Edit lead'
                        : item.source === 'customer'
                          ? 'Edit customer'
                          : mine
                            ? 'Edit my cell number'
                            : 'Edit contact'}
                    </Text>
                  </Pressable>
                ) : null}
                {item.source === 'contact' ? (
                  <Pressable
                    onPress={() => void archive(item)}
                    style={({ pressed }) => [styles.manage, pressed && styles.pressed]}>
                    <Ionicons name="archive-outline" size={14} color={colors.inkSoft} />
                    <Text style={[styles.manageText, styles.manageTextMuted]}>Remove from contacts</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
    );
  };

  const showImport = isAdmin && Platform.OS !== 'web' && deviceContactsSupported();

  const header = (
    <View style={styles.headerArea}>
      <View style={styles.searchRow}>
        <Ionicons name="search" size={16} color={colors.inkSoft} />
        <TextInput
          value={search}
          onChangeText={setSearch}
          placeholder="Search name, company, tag or number"
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
        {SOURCE_FILTERS.map((option) => (
          <Chip
            key={option.key}
            label={option.label}
            tone="ocean"
            selected={filter === option.key}
            onPress={() => setFilter(option.key)}
          />
        ))}
      </View>
      {tagChips.length ? (
        <View style={styles.filters}>
          {tagChips.map((tag) => (
            <Chip
              key={tag}
              label={tagLabel(tag)}
              tone="olive"
              icon="pricetag-outline"
              selected={filter === `tag:${tag}`}
              onPress={() => setFilter(filter === `tag:${tag}` ? 'all' : `tag:${tag}`)}
            />
          ))}
        </View>
      ) : null}
      {isAdmin ? (
        <View style={styles.buttonRow}>
          <Pressable
            onPress={() => {
              setOpenKey(null);
              setNote(null);
              setEditor({ kind: 'new' });
            }}
            style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
            <Ionicons name="add" size={16} color={colors.ocean} />
            <Text style={styles.addButtonText}>Add contact</Text>
          </Pressable>
          {showImport ? (
            <Pressable
              onPress={() => router.push('/contacts/import' as never)}
              style={({ pressed }) => [styles.addButton, pressed && styles.pressed]}>
              <Ionicons name="phone-portrait-outline" size={16} color={colors.ocean} />
              <Text style={styles.addButtonText}>Import from phone</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
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

  const sheetTitle =
    editor?.kind === 'new'
      ? 'New contact'
      : editor?.kind === 'contact'
        ? 'Edit contact'
        : editor?.kind === 'customer'
          ? 'Edit customer'
          : editor?.kind === 'myCell'
            ? 'My cell number'
            : '';

  const closeEditor = () => setEditor(null);

  const editorSheet = (
    <EditorSheet visible={editor !== null} title={sheetTitle} onClose={closeEditor}>
      {editor?.kind === 'new' ? (
        <ContactEditor
          flat
          accent={hubColors.crm.fg}
          tagSuggestions={tagChips}
          onSaved={() => {
            setFilter('contact');
            void onSaved('Contact added.');
          }}
          onCancel={closeEditor}
        />
      ) : editor?.kind === 'contact' ? (
        <ContactEditor
          flat
          accent={hubColors.crm.fg}
          contact={editor.contact}
          defaultCustomer={
            editor.contact.customerId
              ? {
                  id: editor.contact.customerId,
                  name: customerNames.get(editor.contact.customerId) ?? 'Customer',
                }
              : null
          }
          tagSuggestions={tagChips}
          onSaved={() => void onSaved('Saved.')}
          onCancel={closeEditor}
        />
      ) : editor?.kind === 'customer' ? (
        <CustomerEditor
          customerId={editor.id}
          onSaved={(name) => void onSaved(`${name} updated.`)}
          onCancel={closeEditor}
        />
      ) : editor?.kind === 'myCell' ? (
        <MyCellEditor
          initial={profile?.cellPhone ?? null}
          onSaved={() => void onSaved('Your cell number is saved.')}
          onCancel={closeEditor}
        />
      ) : null}
    </EditorSheet>
  );

  if (loading) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  return (
    <>
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
                : 'Customers, leads, the crew and company contacts all show up here once they have a record.'}
            </Text>
          </View>
        }
      />
      {editorSheet}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
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
  buttonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
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
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingTop: 4 },
  editPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: hubColors.crm.bg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 1,
  },
  editPillText: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '800' },

  sheet: {
    backgroundColor: colors.surface,
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
  manageRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  manage: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  manageText: { color: colors.ocean, fontSize: 12, fontWeight: '700' },
  manageTextMuted: { color: colors.inkSoft },

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
