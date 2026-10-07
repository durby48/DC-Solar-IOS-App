import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { deleteCustomerNote, updateCustomerNote, type CustomerNote } from '@/lib/crm';
import { personName } from '@/lib/staffNames';

/**
 * One note ENTRY (2026-10-09, Carson: "notes are entries, and they can be
 * edited but they have a time stamp and date. Also have a delete button").
 *
 * Who wrote it and when ("Ken · Oct 9, 2026 · 3:42 PM"), plus "edited …" once
 * it has been changed. Its author — or an admin — gets Edit (in place,
 * Save / Cancel) and Delete (asks once, then deletes for good). RLS enforces
 * the same rule: cn_author_update / cn_author_delete / cn_admin_all.
 */

/** "Oct 9, 2026 · 3:42 PM" */
export function noteStamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

function author(email: string): string {
  if (email === 'imported') return 'Imported';
  return personName(email) ?? email;
}

export function NoteEntry({
  note,
  canChange,
  onChanged,
}: {
  note: CustomerNote;
  /** The author, or an admin. */
  canChange: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const edited =
    note.updated_at !== null && new Date(note.updated_at).getTime() - new Date(note.created_at).getTime() > 60_000;

  const save = async () => {
    setBusy(true);
    setError(null);
    const result = await updateCustomerNote(note.id, { body: draft });
    setBusy(false);
    if (result.ok) {
      setEditing(false);
      onChanged();
    } else {
      setError(result.message);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    const result = await deleteCustomerNote(note.id);
    setBusy(false);
    if (result.ok) {
      setConfirming(false);
      onChanged();
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={[styles.card, note.pinned && styles.pinned]}>
      {editing ? (
        <TextInput
          value={draft}
          onChangeText={setDraft}
          multiline
          autoFocus
          textAlignVertical="top"
          style={styles.input}
          placeholderTextColor={colors.inkSoft}
        />
      ) : (
        <Text style={styles.body} selectable>
          {note.body}
        </Text>
      )}

      <View style={styles.footer}>
        <Text style={styles.meta}>
          {note.pinned ? 'Pinned · ' : ''}
          {author(note.author_email)} · {noteStamp(note.created_at)}
          {edited ? ` · edited ${noteStamp(note.updated_at)}` : ''}
        </Text>
        {canChange && !editing && !confirming ? (
          <View style={styles.actions}>
            <Pressable
              onPress={() => {
                setDraft(note.body);
                setEditing(true);
                setError(null);
              }}
              hitSlop={6}
              accessibilityLabel="Edit note"
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <Ionicons name="create-outline" size={16} color={colors.ocean} />
              <Text style={styles.actionText}>Edit</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setConfirming(true);
                setError(null);
              }}
              hitSlop={6}
              accessibilityLabel="Delete note"
              style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
              <Ionicons name="trash-outline" size={16} color={colors.danger} />
              <Text style={[styles.actionText, styles.danger]}>Delete</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

      {editing ? (
        <View style={styles.row}>
          <Pressable onPress={() => setEditing(false)} disabled={busy} style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}>
            <Text style={styles.ghostText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={() => void save()}
            disabled={busy || !draft.trim() || draft.trim() === note.body.trim()}
            style={({ pressed }) => [
              styles.primary,
              (pressed || busy || !draft.trim() || draft.trim() === note.body.trim()) && styles.pressed,
            ]}>
            {busy ? <ActivityIndicator color={colors.textOnAction} size="small" /> : <Text style={styles.primaryText}>Save</Text>}
          </Pressable>
        </View>
      ) : null}

      {confirming ? (
        <View style={styles.row}>
          <Text style={styles.confirmText}>Delete this note for good?</Text>
          <Pressable onPress={() => setConfirming(false)} disabled={busy} style={({ pressed }) => [styles.ghost, pressed && styles.pressed]}>
            <Text style={styles.ghostText}>Cancel</Text>
          </Pressable>
          <Pressable onPress={() => void remove()} disabled={busy} style={({ pressed }) => [styles.deleteButton, (pressed || busy) && styles.pressed]}>
            {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.deleteText}>Delete</Text>}
          </Pressable>
        </View>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  pinned: { backgroundColor: colors.amberSoft },
  body: { color: colors.ink, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  input: {
    minHeight: 90,
    color: colors.ink,
    fontSize: 14,
    lineHeight: 20,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radii.sm,
    padding: spacing.sm,
    backgroundColor: colors.cream,
  },
  footer: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm },
  meta: { flex: 1, minWidth: 160, color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: spacing.md },
  action: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  actionText: { color: colors.ocean, fontSize: 12, fontWeight: '800' },
  danger: { color: colors.danger },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.sm, flexWrap: 'wrap' },
  confirmText: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '700' },
  ghost: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: colors.cream },
  ghostText: { color: colors.inkSoft, fontSize: 13, fontWeight: '800' },
  primary: { minWidth: 80, alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: colors.sun },
  primaryText: { color: colors.textOnAction, fontSize: 13, fontWeight: '800' },
  deleteButton: { minWidth: 80, alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill, backgroundColor: colors.danger },
  deleteText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  pressed: { opacity: 0.6 },
});
