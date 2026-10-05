import Ionicons from '@expo/vector-icons/Ionicons';
import { useState, type ComponentProps } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { createLead } from '@/lib/leads';

/**
 * A sales rep's "New prospect" form (2026-10-05), shown in the workspace in
 * place of the centre column.
 *
 * Admins add leads on `/leads`, an admin-only screen with projections and
 * assignment; a sales login never reaches it. This is the short version: who,
 * how to reach them, where they came from. The prospect is inserted already
 * assigned to the rep — `leads_sales_insert` refuses anything else — and an
 * admin can reassign it later.
 */
export function ProspectForm({
  myEmail,
  onCreated,
  onCancel,
}: {
  myEmail: string;
  onCreated: (leadId: string) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ name: '', phone: '', email: '', address: '', source: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!form.name.trim()) {
      setError('A name is required.');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createLead(form, myEmail, myEmail);
    setSaving(false);
    if (result.ok) onCreated(result.id);
    else setError(result.message);
  };

  const field = (key: keyof typeof form, placeholder: string, extra?: Partial<ComponentProps<typeof TextInput>>) => (
    <TextInput
      value={form[key]}
      onChangeText={(v) => {
        setForm((f) => ({ ...f, [key]: v }));
        if (error) setError(null);
      }}
      placeholder={placeholder}
      placeholderTextColor={colors.inkSoft}
      style={styles.input}
      {...extra}
    />
  );

  return (
    <ScrollView
      style={styles.column}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets>
      <View style={styles.titleRow}>
        <Ionicons name="person-add-outline" size={18} color={hubColors.crm.fg} />
        <Text style={styles.title}>New prospect</Text>
      </View>
      <Text style={styles.hint}>It is assigned to you. Name, phone, email and address are needed before a visit can be booked.</Text>
      <View style={styles.form}>
        {field('name', 'Name (person or business)', { autoCapitalize: 'words' })}
        {field('phone', 'Phone', { keyboardType: 'phone-pad' })}
        {field('email', 'Email', { keyboardType: 'email-address', autoCapitalize: 'none' })}
        {field('address', 'Address')}
        {field('source', 'Source (referral, permit list, door knock…)')}
        {field('notes', 'Notes', { multiline: true, style: [styles.input, styles.notes] })}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.buttons}>
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => void save()}
            disabled={saving}
            style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
            {saving ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.saveText}>Add prospect</Text>}
          </Pressable>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: spacing.lg, gap: spacing.md, maxWidth: 560, width: '100%' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  hint: { color: colors.inkSoft, fontSize: 13 },
  form: { gap: spacing.sm },
  input: {
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
  },
  notes: { minHeight: 80, textAlignVertical: 'top' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  save: { backgroundColor: colors.sun, paddingHorizontal: spacing.lg, paddingVertical: 6, borderRadius: radii.pill, minWidth: 110, alignItems: 'center' },
  saveText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
