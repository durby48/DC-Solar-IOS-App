import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ContactEditor } from '@/components/contacts/ContactEditor';
import { Chip } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  NOT_CONFIGURED_VOICE,
  fetchCommsSettings,
  fetchMyStaffProfile,
  formatPhone,
  placeBridgeCall,
} from '@/lib/comms';
import {
  archiveContact,
  attachContactToCustomer,
  collectTags,
  contactSubtitle,
  fetchContacts,
  fetchContactsForCustomer,
  setPrimaryContact,
  tagLabel,
  type CompanyContact,
} from '@/lib/contacts';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * The people behind one customer — a contractor's PM, office, site lead.
 * Rendered as the "Contacts" segment on the phone record and as a block on
 * the web DetailPanel; loads its own rows so neither screen has to.
 *
 * WHAT A ROW DOES. Tap → the same four moves the customer's own number has:
 * Call via DC Solar (in-app on a build with the voice SDK, else the bridge,
 * both filed under `contact_id`), Text via DC Solar (the shared thread),
 * Call from my phone, Email. Admins also get Make primary / Edit / Detach /
 * Remove. The customer's OWN phone and email stay on the Overview — these
 * are the additional people.
 *
 * "ADD CONTACT" IS TWO DOORS: a new person (the editor, customer fixed), or
 * an existing stand-alone contact from the directory ("the inspector we
 * already have is also Cromwell's inspector"), searched and attached.
 */
export function CustomerContacts({
  customerId,
  customerName,
  isAdmin,
  smsReady: smsReadyProp,
  voiceReady: voiceReadyProp,
  hasStaffNumber: hasStaffNumberProp,
  jobId = null,
}: {
  customerId: string;
  customerName: string;
  isAdmin: boolean;
  /**
   * Whether the DC Solar rows are live. Pass them when the screen already
   * has `comms_settings` / the staff profile (the phone record does); leave
   * them out and the block reads both itself (the web DetailPanel).
   */
  smsReady?: boolean;
  voiceReady?: boolean;
  hasStaffNumber?: boolean;
  jobId?: string | null;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState<CompanyContact[]>([]);
  const [allTags, setAllTags] = useState<string[]>([]);
  const [ownReady, setOwnReady] = useState({ sms: false, voice: false, staff: false });
  const smsReady = smsReadyProp ?? ownReady.sms;
  const voiceReady = voiceReadyProp ?? ownReady.voice;
  const hasStaffNumber = hasStaffNumberProp ?? ownReady.staff;
  const needsOwnReady = smsReadyProp === undefined || voiceReadyProp === undefined || hasStaffNumberProp === undefined;

  useEffect(() => {
    if (!needsOwnReady) return;
    let cancelled = false;
    void Promise.all([fetchCommsSettings(), fetchMyStaffProfile()]).then(([s, p]) => {
      if (cancelled) return;
      setOwnReady({
        sms: s?.smsEnabled === true,
        voice: s?.voiceEnabled === true,
        staff: Boolean(p?.cellPhoneE164),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [needsOwnReady]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState<CompanyContact | null>(null);
  const [adding, setAdding] = useState<'none' | 'new' | 'existing'>('none');
  const [pool, setPool] = useState<CompanyContact[] | null>(null);
  const [poolSearch, setPoolSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'error' | 'info'; text: string } | null>(null);

  const load = useCallback(async () => {
    const [rows, everyone] = await Promise.all([fetchContactsForCustomer(customerId), fetchContacts()]);
    setContacts(rows);
    setAllTags(collectTags(everyone));
    setLoading(false);
  }, [customerId]);

  useEffect(() => {
    setLoading(true);
    setOpenId(null);
    setEditing(null);
    setAdding('none');
    void load();
  }, [load]);

  useEffect(() => {
    if (adding !== 'existing' || pool !== null) return;
    void fetchContacts({ unattachedOnly: true }).then(setPool);
  }, [adding, pool]);

  const reload = async () => {
    setPool(null);
    await load();
  };

  const finish = (result: { ok: true } | { ok: false; message: string }, okText: string) => {
    setBusyId(null);
    if (result.ok) {
      setNote({ kind: 'ok', text: okText });
      void reload();
    } else {
      setNote({ kind: 'error', text: result.message });
    }
  };

  const call = async (contact: CompanyContact) => {
    if (!contact.phoneE164 || busyId) return;
    if (voiceReady && inAppCallingSupported()) {
      router.push({
        pathname: '/call',
        params: { to: contact.phoneE164, name: contact.name, contactId: contact.id },
      } as never);
      return;
    }
    if (!voiceReady || !hasStaffNumber) {
      setNote({
        kind: 'error',
        text: !voiceReady ? NOT_CONFIGURED_VOICE : 'Add your cell number in Messages settings — the bridge rings it first.',
      });
      return;
    }
    setBusyId(contact.id);
    setNote({ kind: 'info', text: `Ringing your cell, then ${contact.name}…` });
    const result = await placeBridgeCall({ contactId: contact.id, jobId: jobId ?? undefined });
    setBusyId(null);
    setNote(result.ok ? { kind: 'ok', text: 'Pick up your phone — we are dialling them next.' } : { kind: 'error', text: result.message });
  };

  const text = (contact: CompanyContact) => {
    if (!contact.phoneE164) return;
    router.push({
      pathname: '/messages/thread',
      params: { phone: contact.phoneE164, name: contact.name, contactId: contact.id },
    } as never);
  };

  const makePrimary = async (contact: CompanyContact) => {
    setBusyId(contact.id);
    finish(await setPrimaryContact(customerId, contact.id), `${contact.name} is now the primary contact.`);
  };

  const detach = async (contact: CompanyContact) => {
    setBusyId(contact.id);
    finish(await attachContactToCustomer(contact.id, null), `${contact.name} is no longer filed under ${customerName}.`);
  };

  const remove = async (contact: CompanyContact) => {
    setConfirmRemoveId(null);
    setBusyId(contact.id);
    finish(await archiveContact(contact.id), `${contact.name} removed from the directory.`);
  };

  const attachExisting = async (contact: CompanyContact) => {
    setBusyId(contact.id);
    const result = await attachContactToCustomer(contact.id, customerId);
    if (result.ok) setAdding('none');
    finish(result, `${contact.name} filed under ${customerName}.`);
  };

  const poolQ = poolSearch.trim().toLowerCase();
  const poolRows = (pool ?? [])
    .filter((c) => !poolQ || c.name.toLowerCase().includes(poolQ) || (c.org ?? '').toLowerCase().includes(poolQ))
    .slice(0, 20);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text style={styles.title}>{`Contacts${contacts.length ? ` · ${contacts.length}` : ''}`}</Text>
        {isAdmin && adding === 'none' && !editing ? (
          <View style={styles.headActions}>
            <Pressable onPress={() => setAdding('new')} hitSlop={6} style={({ pressed }) => [styles.headButton, pressed && styles.pressed]}>
              <Ionicons name="person-add-outline" size={14} color={hubColors.crm.fg} />
              <Text style={styles.headButtonText}>New</Text>
            </Pressable>
            <Pressable onPress={() => setAdding('existing')} hitSlop={6} style={({ pressed }) => [styles.headButton, pressed && styles.pressed]}>
              <Ionicons name="link-outline" size={14} color={hubColors.crm.fg} />
              <Text style={styles.headButtonText}>Existing</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {adding === 'new' ? (
        <ContactEditor
          defaultCustomer={{ id: customerId, name: customerName }}
          lockedCustomer
          tagSuggestions={allTags}
          accent={hubColors.crm.fg}
          onSaved={() => {
            setAdding('none');
            setNote({ kind: 'ok', text: 'Contact added.' });
            void reload();
          }}
          onCancel={() => setAdding('none')}
        />
      ) : null}

      {adding === 'existing' ? (
        <View style={styles.pool}>
          <View style={styles.poolHead}>
            <Text style={styles.poolTitle}>Attach an existing contact</Text>
            <Pressable onPress={() => setAdding('none')} hitSlop={8}>
              <Ionicons name="close" size={18} color={colors.inkSoft} />
            </Pressable>
          </View>
          <View style={styles.searchRow}>
            <Ionicons name="search" size={14} color={colors.inkSoft} />
            <TextInput
              value={poolSearch}
              onChangeText={setPoolSearch}
              placeholder="Search unattached contacts"
              placeholderTextColor={colors.inkSoft}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
          </View>
          {pool === null ? (
            <ActivityIndicator color={hubColors.crm.fg} style={styles.spinner} />
          ) : poolRows.length === 0 ? (
            <Text style={styles.empty}>
              {pool.length === 0 ? 'Every contact in the directory is already filed under a customer.' : 'No contact matches.'}
            </Text>
          ) : (
            poolRows.map((c) => (
              <Pressable
                key={c.id}
                onPress={() => void attachExisting(c)}
                disabled={busyId !== null}
                style={({ pressed }) => [styles.poolRow, pressed && styles.rowPressed]}>
                <View style={styles.rowBody}>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {[contactSubtitle(c), c.tags.map(tagLabel).join(', ')].filter(Boolean).join(' · ')}
                  </Text>
                </View>
                {busyId === c.id ? <ActivityIndicator size="small" color={hubColors.crm.fg} /> : <Ionicons name="add-circle-outline" size={18} color={hubColors.crm.fg} />}
              </Pressable>
            ))
          )}
        </View>
      ) : null}

      {loading ? (
        <ActivityIndicator color={hubColors.crm.fg} style={styles.spinner} />
      ) : contacts.length === 0 && adding === 'none' ? (
        <Text style={styles.empty}>
          {isAdmin
            ? `Nobody filed under ${customerName} yet. Add the people you deal with here — a project manager, the office, the site lead.`
            : `Nobody filed under ${customerName} yet.`}
        </Text>
      ) : null}

      {contacts.map((contact) => {
        const open = openId === contact.id;
        const dialable = Boolean(contact.phoneE164);
        const subtitle = contactSubtitle(contact);
        if (editing?.id === contact.id) {
          return (
            <ContactEditor
              key={contact.id}
              contact={contact}
              defaultCustomer={{ id: customerId, name: customerName }}
              lockedCustomer
              tagSuggestions={allTags}
              accent={hubColors.crm.fg}
              onSaved={() => {
                setEditing(null);
                setNote({ kind: 'ok', text: 'Saved.' });
                void reload();
              }}
              onCancel={() => setEditing(null)}
            />
          );
        }
        return (
          <View key={contact.id} style={styles.card}>
            <Pressable
              onPress={() => {
                setOpenId(open ? null : contact.id);
                setConfirmRemoveId(null);
                setNote(null);
              }}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              <View style={styles.rowBody}>
                <View style={styles.nameRow}>
                  {contact.isPrimary ? <Ionicons name="star" size={13} color={colors.amberDeep} /> : null}
                  <Text style={styles.rowName} numberOfLines={1}>
                    {contact.name}
                  </Text>
                </View>
                {subtitle ? (
                  <Text style={styles.rowMeta} numberOfLines={1}>
                    {subtitle}
                  </Text>
                ) : null}
                <Text style={[styles.rowPhone, !dialable && styles.rowPhoneMissing]} numberOfLines={1}>
                  {dialable ? formatPhone(contact.phoneE164) : contact.phone ? `${contact.phone} · not a US number` : 'No phone'}
                  {contact.email ? `  ·  ${contact.email}` : ''}
                </Text>
                {contact.tags.length ? (
                  <View style={styles.tags}>
                    {contact.tags.map((tag) => (
                      <Chip key={tag} label={tagLabel(tag)} tone="neutral" />
                    ))}
                  </View>
                ) : null}
              </View>
              <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.inkSoft} />
            </Pressable>

            {open ? (
              <View style={styles.actionsArea}>
                <View style={styles.actions}>
                  <Pressable
                    onPress={() => void call(contact)}
                    disabled={!dialable || busyId !== null}
                    style={({ pressed }) => [styles.action, !dialable && styles.actionMuted, pressed && styles.pressed]}>
                    {busyId === contact.id ? <ActivityIndicator color={colors.ink} size="small" /> : <Ionicons name="call" size={15} color={colors.ink} />}
                    <Text style={styles.actionLabel}>Call</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => text(contact)}
                    disabled={!dialable || !smsReady}
                    style={({ pressed }) => [styles.action, styles.actionSecondary, (!dialable || !smsReady) && styles.actionMuted, pressed && styles.pressed]}>
                    <Ionicons name="chatbubble" size={15} color={hubColors.crm.fg} />
                    <Text style={[styles.actionLabel, styles.actionLabelSecondary]}>Text</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => Linking.openURL(`tel:${contact.phoneE164 ?? contact.phone ?? ''}`).catch(() => {})}
                    disabled={!contact.phone}
                    style={({ pressed }) => [styles.action, styles.actionSecondary, !contact.phone && styles.actionMuted, pressed && styles.pressed]}>
                    <Ionicons name="phone-portrait" size={15} color={hubColors.crm.fg} />
                    <Text style={[styles.actionLabel, styles.actionLabelSecondary]}>My phone</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => Linking.openURL(`mailto:${contact.email ?? ''}`).catch(() => {})}
                    disabled={!contact.email}
                    style={({ pressed }) => [styles.action, styles.actionSecondary, !contact.email && styles.actionMuted, pressed && styles.pressed]}>
                    <Ionicons name="mail" size={15} color={hubColors.crm.fg} />
                    <Text style={[styles.actionLabel, styles.actionLabelSecondary]}>Email</Text>
                  </Pressable>
                </View>
                {isAdmin ? (
                  <View style={styles.manage}>
                    {!contact.isPrimary ? (
                      <Pressable onPress={() => void makePrimary(contact)} disabled={busyId !== null} style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}>
                        <Ionicons name="star-outline" size={14} color={hubColors.crm.fg} />
                        <Text style={styles.manageText}>Make primary</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={() => setEditing(contact)} style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}>
                      <Ionicons name="create-outline" size={14} color={hubColors.crm.fg} />
                      <Text style={styles.manageText}>Edit</Text>
                    </Pressable>
                    <Pressable onPress={() => void detach(contact)} disabled={busyId !== null} style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}>
                      <Ionicons name="unlink-outline" size={14} color={colors.inkSoft} />
                      <Text style={[styles.manageText, styles.manageTextMuted]}>Detach</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => (confirmRemoveId === contact.id ? void remove(contact) : setConfirmRemoveId(contact.id))}
                      disabled={busyId !== null}
                      style={({ pressed }) => [styles.manageButton, pressed && styles.pressed]}>
                      <Ionicons name="archive-outline" size={14} color={confirmRemoveId === contact.id ? colors.danger : colors.inkSoft} />
                      <Text style={[styles.manageText, confirmRemoveId === contact.id ? styles.manageTextDanger : styles.manageTextMuted]}>
                        {confirmRemoveId === contact.id ? 'Tap again to remove' : 'Remove'}
                      </Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}

      {note ? (
        <Text style={[styles.note, note.kind === 'error' ? styles.noteError : note.kind === 'ok' ? styles.noteOk : null]}>{note.text}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  headActions: { flexDirection: 'row', gap: spacing.xs },
  headButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderRadius: radii.pill,
    backgroundColor: hubColors.crm.bg,
  },
  headButtonText: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '800' },
  spinner: { paddingVertical: spacing.md },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600' },
  card: { backgroundColor: colors.white, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  rowPressed: { backgroundColor: hubColors.crm.bg },
  rowBody: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowName: { color: colors.ink, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  rowMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  rowPhone: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '700' },
  rowPhoneMissing: { color: colors.inkSoft, fontStyle: 'italic', fontWeight: '600' },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, paddingTop: 4 },
  actionsArea: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line,
    padding: spacing.sm,
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomLeftRadius: radii.md,
    borderBottomRightRadius: radii.md,
  },
  actions: { flexDirection: 'row', gap: spacing.xs },
  action: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingVertical: spacing.sm,
    paddingHorizontal: 4,
  },
  actionSecondary: { backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line },
  actionMuted: { opacity: 0.45 },
  actionLabel: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  actionLabelSecondary: { color: hubColors.crm.fg },
  manage: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  manageButton: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
  manageText: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '700' },
  manageTextMuted: { color: colors.inkSoft },
  manageTextDanger: { color: colors.danger },
  pool: { backgroundColor: colors.white, borderRadius: radii.md, borderWidth: 1, borderColor: colors.line, padding: spacing.sm, gap: spacing.xs },
  poolHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  poolTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  poolRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs + 2,
  },
  searchInput: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '500', paddingVertical: 2 },
  note: { fontSize: 13, fontWeight: '700', color: hubColors.crm.fg },
  noteOk: { color: colors.success },
  noteError: { color: colors.danger },
  pressed: { opacity: 0.6 },
});
