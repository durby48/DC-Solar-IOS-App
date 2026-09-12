import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, hubColors, radii, spacing } from '@/constants/theme';
import { fetchCrewContact, saveCrewContact } from '@/lib/comms';

import { DeviceContactPicker } from './DeviceContactPicker';
import { deviceContactsSupported } from './deviceContacts';

/**
 * A crew member's contact information, edited by an admin (Build 33).
 *
 * Crew contact info is the name on `employees` and the cell number on
 * `staff_profiles` — the same two fields the directory already shows and
 * dials. It is saved through `set_crew_contact()`, which only ever UPDATES the
 * existing crew member: role, pay rate, login email and job history are out
 * of its reach, and no second crew record can be created.
 *
 * "Import from iPhone" picks one address-book contact and FILLS the form —
 * the name only when the iPhone card has one, the number only when it has
 * one — so a blank iPhone field never wipes what the app already knows.
 * Nothing is saved until Save.
 */
export function CrewContactEditor({
  employeeId,
  onSaved,
  onCancel,
}: {
  employeeId: string;
  onSaved: (name: string) => void;
  onCancel: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCrewContact(employeeId).then((row) => {
      if (cancelled) return;
      setLoading(false);
      if (!row) {
        setMessage({ kind: 'error', text: 'Could not load this crew member.' });
        return;
      }
      setEmail(row.email);
      setName(row.displayName ?? '');
      setPhone(row.cellPhone ?? '');
    });
    return () => {
      cancelled = true;
    };
  }, [employeeId]);

  const save = async () => {
    setMessage(null);
    setSaving(true);
    const result = await saveCrewContact(employeeId, { displayName: name, cellPhone: phone });
    setSaving(false);
    if (!result.ok) {
      setMessage({ kind: 'error', text: result.message });
      return;
    }
    onSaved(name.trim() || email || 'Crew member');
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>
    );
  }

  if (picking) {
    return (
      <DeviceContactPicker
        onCancel={() => setPicking(false)}
        onPick={(contact) => {
          setPicking(false);
          const filled: string[] = [];
          if (contact.name.trim()) {
            setName(contact.name.trim());
            filled.push('name');
          }
          if (contact.phones[0]) {
            setPhone(contact.phones[0]);
            filled.push('cell number');
          }
          setMessage({
            kind: 'info',
            text: filled.length
              ? `Filled the ${filled.join(' and ')} from ${contact.name}. Check it, then Save.`
              : `${contact.name} has no name or number on the iPhone card — nothing changed.`,
          });
        }}
      />
    );
  }

  const canImport = Platform.OS !== 'web' && deviceContactsSupported();

  return (
    <View style={styles.form}>
      {email ? <Text style={styles.hint}>Signs in as {email} — the login email is not changed here.</Text> : null}

      {canImport ? (
        <Pressable
          onPress={() => {
            setMessage(null);
            setPicking(true);
          }}
          accessibilityRole="button"
          style={({ pressed }) => [styles.importButton, pressed && styles.pressed]}>
          <Ionicons name="phone-portrait-outline" size={16} color={hubColors.crm.fg} />
          <Text style={styles.importText}>Import from iPhone Contacts</Text>
        </Pressable>
      ) : null}

      <Text style={styles.label}>Name</Text>
      <TextInput
        value={name}
        onChangeText={setName}
        placeholder="First and last name"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="words"
        style={styles.input}
      />

      <Text style={styles.label}>Cell number</Text>
      <TextInput
        value={phone}
        onChangeText={setPhone}
        placeholder="(816) 555-0100"
        placeholderTextColor={colors.textMuted}
        keyboardType="phone-pad"
        style={styles.input}
      />
      <Text style={styles.hint}>The number the directory dials and texts, and the phone rung first on a bridge call.</Text>

      {message ? (
        <Text style={message.kind === 'error' ? styles.error : styles.info}>{message.text}</Text>
      ) : null}

      <View style={styles.buttons}>
        <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
        <Pressable
          onPress={() => void save()}
          disabled={saving || !email}
          style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? (
            <ActivityIndicator color={colors.textOnAction} size="small" />
          ) : (
            <Text style={styles.saveText}>Save</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', paddingVertical: spacing.lg },
  form: { gap: spacing.sm },
  label: { color: colors.textMuted, fontSize: 12, fontWeight: '800', letterSpacing: 0.6, textTransform: 'uppercase' },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
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
  importButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    alignSelf: 'flex-start',
    backgroundColor: hubColors.crm.bg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  importText: { color: hubColors.crm.deep, fontSize: 13, fontWeight: '800' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  info: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
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
