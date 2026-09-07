import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { createTask, dueFromPick } from '@/lib/tasks';

/**
 * Add a task inline: title, when (Today / Tomorrow / Next week / a date /
 * none), who (you by default). No modal, no type picker — Atomic CRM's
 * AddTask dialog reduced to the three things the crew actually fills in.
 * Defaults are the useful ones: due today at 9, assigned to you.
 */
type Due = 'today' | 'tomorrow' | 'nextWeek' | 'date' | 'none';

export function TaskComposer({
  reps,
  myEmail,
  link,
  autoFocus = true,
  onAdded,
  onCancel,
}: {
  reps: { email: string; name: string }[];
  myEmail: string | null;
  /** What the task is about. All optional — a bare to-do is fine. */
  link?: { customerId?: string | null; leadId?: string | null; jobId?: string | null };
  autoFocus?: boolean;
  onAdded: () => void;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState<Due>('today');
  const [dateText, setDateText] = useState('');
  const [assignee, setAssignee] = useState<string | null>(myEmail);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = reps.filter((r) => r.email.toLowerCase() !== myEmail?.toLowerCase());

  const submit = async () => {
    if (!title.trim()) {
      setError('Give the task a title.');
      return;
    }
    let dueAt: string | null = null;
    if (due === 'date') {
      dueAt = dueFromPick(dateText);
      if (!dueAt) {
        setError('Type the date as YYYY-MM-DD.');
        return;
      }
    } else if (due !== 'none') {
      dueAt = dueFromPick(due);
    }
    setSaving(true);
    setError(null);
    const result = await createTask({
      title,
      dueAt,
      assignedTo: assignee,
      customerId: link?.customerId ?? null,
      leadId: link?.leadId ?? null,
      jobId: link?.jobId ?? null,
    });
    setSaving(false);
    if (result.ok) {
      setTitle('');
      setDateText('');
      onAdded();
    } else {
      setError(result.message);
    }
  };

  return (
    <View style={styles.box}>
      <TextInput
        value={title}
        onChangeText={setTitle}
        placeholder="Call back about the estimate…"
        placeholderTextColor={colors.inkSoft}
        autoFocus={autoFocus}
        onSubmitEditing={() => void submit()}
        returnKeyType="done"
        style={styles.input}
      />
      <Text style={styles.label}>When</Text>
      <View style={styles.chips}>
        {(
          [
            ['today', 'Today'],
            ['tomorrow', 'Tomorrow'],
            ['nextWeek', 'Next week'],
            ['date', 'Date…'],
            ['none', 'No date'],
          ] as [Due, string][]
        ).map(([key, label]) => (
          <Chip key={key} label={label} tone="ocean" selected={due === key} onPress={() => setDue(key)} />
        ))}
      </View>
      {due === 'date' ? (
        <TextInput
          value={dateText}
          onChangeText={setDateText}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.inkSoft}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, styles.dateInput]}
        />
      ) : null}
      <Text style={styles.label}>Who</Text>
      <View style={styles.chips}>
        {myEmail ? <Chip label="Me" tone="olive" selected={assignee?.toLowerCase() === myEmail.toLowerCase()} onPress={() => setAssignee(myEmail)} /> : null}
        {others.map((r) => (
          <Chip key={r.email} label={r.name} tone="olive" selected={assignee?.toLowerCase() === r.email.toLowerCase()} onPress={() => setAssignee(r.email)} />
        ))}
        <Chip label="Nobody" tone="neutral" selected={assignee === null} onPress={() => setAssignee(null)} />
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.buttons}>
        {onCancel ? (
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.cancel, pressed && styles.pressed]}>
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => void submit()} disabled={saving} style={({ pressed }) => [styles.save, (pressed || saving) && styles.pressed]}>
          {saving ? <ActivityIndicator color={colors.ink} size="small" /> : <Text style={styles.saveText}>Add task</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.xs, backgroundColor: colors.canvas, borderRadius: radii.sm, padding: spacing.sm, borderWidth: 1, borderColor: colors.line },
  input: {
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  dateInput: { maxWidth: 160 },
  label: { color: colors.inkSoft, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.xs },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  error: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  cancel: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radii.pill },
  cancelText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  save: { backgroundColor: colors.sun, paddingHorizontal: spacing.lg, paddingVertical: 6, borderRadius: radii.pill, minWidth: 90, alignItems: 'center' },
  saveText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  pressed: { opacity: 0.6 },
});
