import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { authorName } from '@/lib/crmWorkspace';
import { deleteTask, dueLabel, postponeTask, setTaskDone, taskBucket, type Task } from '@/lib/tasks';

/**
 * One task: tick, title, "Today 9:00 AM · Devon · Cromwell", and a ⋯ that
 * unfolds Tomorrow / Next week / Delete. Adapted from Atomic CRM's Task.tsx
 * (MIT): the checkbox writes `done_at` straight away with no confirm, the
 * two postpone actions are the whole scheduling UI, and the row never opens
 * a modal.
 *
 * `recordName` + `onOpenRecord` are for the workspace-wide list, where the
 * row needs to say who it is about; inside a record's detail panel both are
 * omitted.
 */
export function TaskItem({
  task,
  reps,
  recordName,
  onChanged,
  onOpenRecord,
}: {
  task: Task;
  reps: { email: string; name: string }[];
  recordName?: string | null;
  onChanged: () => void;
  onOpenRecord?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const done = task.done_at != null;
  const bucket = taskBucket(task);
  const due = dueLabel(task);
  const who = task.assigned_to
    ? (reps.find((r) => r.email.toLowerCase() === task.assigned_to?.toLowerCase())?.name ?? authorName(task.assigned_to))
    : null;

  const run = async (action: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setBusy(true);
    setError(null);
    const result = await action();
    setBusy(false);
    setMenu(false);
    if (result.ok) onChanged();
    else setError(result.message);
  };

  return (
    <View style={styles.row}>
      <Pressable
        onPress={() => void run(() => setTaskDone(task.id, !done))}
        disabled={busy}
        hitSlop={6}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={done ? 'Mark not done' : 'Mark done'}
        style={styles.check}>
        {busy ? (
          <ActivityIndicator size="small" color={colors.olive} />
        ) : (
          <Ionicons name={done ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={done ? colors.olive : colors.inkSoft} />
        )}
      </Pressable>

      <View style={styles.body}>
        <Text style={[styles.title, done && styles.titleDone]} numberOfLines={2}>
          {task.title}
        </Text>
        <View style={styles.metaRow}>
          {due ? <Text style={[styles.meta, bucket === 'overdue' && styles.overdue]}>{due}</Text> : null}
          {who ? <Text style={styles.meta}>{due ? ' · ' : ''}{who}</Text> : null}
          {recordName ? (
            <Pressable onPress={onOpenRecord} disabled={!onOpenRecord} hitSlop={4}>
              <Text style={[styles.meta, onOpenRecord && styles.link]} numberOfLines={1}>
                {due || who ? ' · ' : ''}
                {recordName}
              </Text>
            </Pressable>
          ) : null}
        </View>
        {task.notes ? (
          <Text style={styles.notes} numberOfLines={3}>
            {task.notes}
          </Text>
        ) : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {menu ? (
          <View style={styles.actions}>
            {!done ? <Chip label="Tomorrow" tone="ocean" icon="arrow-forward" onPress={() => void run(() => postponeTask(task, 1))} /> : null}
            {!done ? <Chip label="Next week" tone="ocean" icon="play-forward" onPress={() => void run(() => postponeTask(task, 7))} /> : null}
            <Chip label="Delete" tone="danger" icon="trash-outline" onPress={() => void run(() => deleteTask(task.id))} />
          </View>
        ) : null}
      </View>

      <Pressable onPress={() => setMenu((v) => !v)} hitSlop={8} accessibilityLabel="Task actions" style={styles.more}>
        <Ionicons name={menu ? 'close' : 'ellipsis-horizontal'} size={16} color={colors.inkSoft} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.xs + 2 },
  check: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.ink, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  titleDone: { color: colors.inkSoft, textDecorationLine: 'line-through', fontWeight: '600' },
  metaRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  meta: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  overdue: { color: colors.coralDeep, fontWeight: '800' },
  link: { color: colors.ocean },
  notes: { color: colors.inkSoft, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  error: { color: colors.danger, fontSize: 11, fontWeight: '700' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs, padding: spacing.xs, backgroundColor: colors.canvas, borderRadius: radii.sm },
  more: { width: 24, height: 22, alignItems: 'center', justifyContent: 'center' },
});
