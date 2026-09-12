import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { CustomerPicker, type PickedCustomer } from '@/components/contacts/CustomerPicker';
import { TagPicker } from '@/components/contacts/TagPicker';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import { createContact, updateContact, type CompanyContact } from '@/lib/contacts';

/**
 * Add or edit one contact, inline. Name · company · title · phone · email ·
 * tags · customer link · notes. The same form on the Contacts tab and on a
 * customer record; the record passes `lockedCustomer` so the link cannot be
 * changed from there (that is what "Detach" on the row is for).
 *
 * Saves through `createContact` / `updateContact`; RLS decides — a crew
 * member who reaches this form (they should not; the buttons are admin-only)
 * sees the one-line refusal rather than a stack trace.
 *
 * `flat` drops the card chrome and the "Edit contact" heading for a host that
 * already frames it — the Contacts tab's `EditorSheet`.
 */
export function ContactEditor({
  contact = null,
  defaultCustomer = null,
  lockedCustomer = false,
  tagSuggestions = [],
  accent = colors.ocean,
  flat = false,
  onSaved,
  onCancel,
}: {
  /** Edit this row; null adds a new one. */
  contact?: CompanyContact | null;
  /** Pre-filled customer link for a new contact. */
  defaultCustomer?: PickedCustomer | null;
  lockedCustomer?: boolean;
  tagSuggestions?: readonly string[];
  accent?: string;
  /** No card background / heading: the host draws the frame and the title. */
  flat?: boolean;
  onSaved: (id: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(contact?.name ?? '');
  const [org, setOrg] = useState(contact?.org ?? '');
  const [title, setTitle] = useState(contact?.title ?? '');
  const [phone, setPhone] = useState(contact?.phone ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [tags, setTags] = useState<string[]>(contact?.tags ?? []);
  const [customer, setCustomer] = useState<PickedCustomer | null>(
    contact?.customerId
      ? { id: contact.customerId, name: defaultCustomer?.name ?? 'Customer' }
      : defaultCustomer,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError('Give them a name.');
      return;
    }
    setSaving(true);
    const input = {
      name,
      org,
      title,
      phone,
      email,
      notes,
      tags: tags.length > 0 ? tags : ['other'],
      customerId: customer?.id ?? null,
    };
    if (contact) {
      const result = await updateContact(contact.id, input);
      setSaving(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onSaved(contact.id);
      return;
    }
    const result = await createContact(input);
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved(result.id);
  };

  return (
    <View style={flat ? styles.formFlat : styles.form}>
      {flat ? null : <Text style={styles.title}>{contact ? 'Edit contact' : 'New contact'}</Text>}
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name (person, or the business)"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <TextInput
        value={org}
        onChangeText={setOrg}
        placeholder="Company, e.g. Kansas City Solar Supply"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Their role, e.g. Project manager"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
      <TextInput
        value={phone}
        onChangeText={setPhone}
        placeholder="Phone"
        placeholderTextColor={colors.inkSoft}
        keyboardType="phone-pad"
        style={styles.input}
      />
      <TextInput
        value={email}
        onChangeText={setEmail}
        placeholder="Email (optional)"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        keyboardType="email-address"
        style={styles.input}
      />
      <Text style={styles.label}>Tags</Text>
      <TagPicker value={tags} onChange={setTags} suggestions={tagSuggestions} accent={accent} />
      <Text style={styles.label}>Customer</Text>
      <CustomerPicker value={customer} onChange={setCustomer} locked={lockedCustomer} />
      <TextInput
        value={notes}
        onChangeText={setNotes}
        placeholder="Notes (optional)"
        placeholderTextColor={colors.inkSoft}
        multiline
        style={[styles.input, styles.multiline]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => void save()}
          disabled={saving}
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Save</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.sm,
    ...shadows.card,
  },
  formFlat: { gap: spacing.sm },
  title: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  label: { color: colors.inkSoft, fontSize: 11, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
  },
  multiline: { minHeight: 64, textAlignVertical: 'top' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
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
  saveText: { color: colors.textOnAction, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
