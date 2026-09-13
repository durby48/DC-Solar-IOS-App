import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { ConfirmDeleteButton } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { archiveCustomer, deleteCustomer, fetchCustomerById, updateCustomer } from '@/lib/crm';

/**
 * Edit a CUSTOMER's own card from the directory: name · phone · email ·
 * address · notes — the same five fields the customer record's edit form
 * writes, through the same `updateCustomer` (admin UPDATE in RLS; a crew
 * member who somehow reaches this sees the one-line refusal).
 *
 * The directory row only carries a name, a number and an address, so the
 * full row is fetched on open — a stale email or a note must not be
 * overwritten with an empty string because the list never had it.
 */
export function CustomerEditor({
  customerId,
  onSaved,
  onCancel,
  onDeleted,
}: {
  customerId: string;
  onSaved: (name: string) => void;
  onCancel: () => void;
  /**
   * Offer Delete (2026-09-13). Called with a message once the customer is
   * deleted, or archived instead; omit to hide the control.
   */
  onDeleted?: (message: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Set when delete was refused because of jobs / money: offer Archive. */
  const [history, setHistory] = useState<string | null>(null);

  const remove = async () => {
    if (!onDeleted) return;
    setError(null);
    setDeleting(true);
    const result = await deleteCustomer(customerId);
    setDeleting(false);
    if (result.ok) {
      onDeleted(`${result.name} was deleted.`);
      return;
    }
    setHistory(result.history ?? null);
    setError(result.message);
  };

  const archiveInstead = async () => {
    if (!onDeleted) return;
    setDeleting(true);
    const result = await archiveCustomer(customerId);
    setDeleting(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onDeleted(`${name.trim() || 'The customer'} is archived: hidden everywhere, books untouched.`);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchCustomerById(customerId).then((customer) => {
      if (cancelled) return;
      if (!customer) {
        setMissing(true);
      } else {
        setName(customer.name ?? '');
        setPhone(customer.phone ?? '');
        setEmail(customer.email ?? '');
        setAddress(customer.address ?? '');
        setNotes(customer.notes ?? '');
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [customerId]);

  const save = async () => {
    setError(null);
    if (!name.trim()) {
      setError('The customer needs a name.');
      return;
    }
    setSaving(true);
    const result = await updateCustomer(customerId, {
      name: name.trim(),
      phone: phone.trim() || null,
      email: email.trim() || null,
      address: address.trim() || null,
      notes: notes.trim() || null,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    onSaved(name.trim());
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  }

  if (missing) {
    return (
      <View style={styles.form}>
        <Text style={styles.error}>That customer could not be loaded. Pull to refresh the list.</Text>
        <View style={styles.buttons}>
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
            <Text style={styles.cancelText}>Close</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.form}>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="Name"
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
        placeholder="Email"
        placeholderTextColor={colors.inkSoft}
        autoCapitalize="none"
        keyboardType="email-address"
        style={styles.input}
      />
      <TextInput
        value={address}
        onChangeText={setAddress}
        placeholder="Address"
        placeholderTextColor={colors.inkSoft}
        style={styles.input}
      />
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
      {onDeleted ? (
        <View style={styles.danger}>
          {history ? (
            <Pressable
              onPress={() => void archiveInstead()}
              disabled={deleting}
              style={({ pressed }) => [styles.archiveInstead, pressed && styles.pressed]}>
              <Text style={styles.archiveInsteadText}>Archive instead</Text>
            </Pressable>
          ) : (
            <ConfirmDeleteButton label="Delete customer" busy={deleting} onConfirm={() => void remove()} />
          )}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  danger: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.sm,
    marginTop: spacing.xs,
  },
  archiveInstead: {
    alignSelf: 'flex-start',
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  archiveInsteadText: { color: colors.textPrimary, fontSize: 13, fontWeight: '800' },
  center: { paddingVertical: spacing.xl, alignItems: 'center' },
  form: { gap: spacing.sm },
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
