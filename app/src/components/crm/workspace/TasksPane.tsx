import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { TaskComposer } from '@/components/crm/workspace/TaskComposer';
import { TaskItem } from '@/components/crm/workspace/TaskItem';
import { Chip } from '@/components/ui';
import { colors, radii, spacing } from '@/constants/theme';
import { type WorkspaceRecord } from '@/lib/crmWorkspace';
import { BUCKET_LABEL, bucketTasks, type Task } from '@/lib/tasks';

/**
 * Every task, grouped Overdue / Today / Tomorrow / This week / Later / No
 * date — Atomic CRM's TasksListByDueDate, as the left column's "Tasks" lens.
 * Each row names its customer or lead; tapping that name selects the record
 * so the conversation and details open beside it. "Mine" narrows to what is
 * assigned to you; done tasks stay hidden until asked for.
 */
export function TasksPane({
  tasks,
  records,
  reps,
  myEmail,
  query,
  onChanged,
  onSelectRecord,
}: {
  tasks: Task[];
  records: WorkspaceRecord[];
  reps: { email: string; name: string }[];
  myEmail: string | null;
  query: string;
  onChanged: () => void;
  onSelectRecord: (record: WorkspaceRecord) => void;
}) {
  const [mine, setMine] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [adding, setAdding] = useState(false);

  const byCustomer = useMemo(() => new Map(records.filter((r) => r.kind === 'customer').map((r) => [r.id, r])), [records]);
  const byLead = useMemo(() => new Map(records.filter((r) => r.kind === 'lead').map((r) => [r.id, r])), [records]);

  const recordFor = (t: Task): WorkspaceRecord | null =>
    (t.customer_id ? byCustomer.get(t.customer_id) : null) ?? (t.lead_id ? byLead.get(t.lead_id) : null) ?? null;

  const q = query.trim().toLowerCase();
  const visible = tasks.filter((t) => {
    if (!showDone && t.done_at) return false;
    if (mine && t.assigned_to?.toLowerCase() !== myEmail?.toLowerCase()) return false;
    if (q) {
      const rec = recordFor(t);
      if (!t.title.toLowerCase().includes(q) && !rec?.name.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const sections = bucketTasks(visible).map((b) => ({ title: BUCKET_LABEL[b.bucket], data: b.tasks }));
  const openCount = tasks.filter((t) => !t.done_at).length;

  return (
    <View style={styles.column}>
      <View style={styles.toolbar}>
        <Chip label="Everyone" tone="ocean" selected={!mine} onPress={() => setMine(false)} />
        <Chip label="Mine" tone="ocean" selected={mine} onPress={() => setMine(true)} disabled={!myEmail} />
        <Pressable onPress={() => setShowDone((v) => !v)} style={styles.doneToggle} hitSlop={4}>
          <Ionicons name={showDone ? 'eye' : 'eye-off-outline'} size={13} color={colors.inkSoft} />
          <Text style={styles.doneToggleText}>Done</Text>
        </Pressable>
        <Pressable onPress={() => setAdding((v) => !v)} style={({ pressed }) => [styles.add, pressed && styles.pressed]}>
          <Ionicons name={adding ? 'close' : 'add'} size={14} color={colors.ocean} />
          <Text style={styles.addText}>Task</Text>
        </Pressable>
      </View>
      {adding ? (
        <View style={styles.composer}>
          <TaskComposer
            reps={reps}
            myEmail={myEmail}
            onAdded={() => {
              setAdding(false);
              onChanged();
            }}
            onCancel={() => setAdding(false)}
          />
        </View>
      ) : null}
      <SectionList
        sections={sections}
        keyExtractor={(t) => t.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        renderSectionHeader={({ section }) => (
          <Text style={[styles.bucket, section.title === 'Overdue' && styles.bucketOverdue]}>
            {section.title} · {section.data.length}
          </Text>
        )}
        renderItem={({ item }) => {
          const rec = recordFor(item);
          return (
            <View style={styles.row}>
              <TaskItem
                task={item}
                reps={reps}
                recordName={rec?.name ?? null}
                onChanged={onChanged}
                onOpenRecord={rec ? () => onSelectRecord(rec) : undefined}
              />
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {openCount === 0
              ? 'No open tasks. Add one from a record, or with + Task.'
              : mine
                ? 'Nothing assigned to you.'
                : q
                  ? 'No task matches that search.'
                  : 'Nothing to show.'}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1 },
  toolbar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingBottom: spacing.xs },
  doneToggle: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: spacing.xs, paddingVertical: 4 },
  doneToggleText: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },
  add: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderWidth: 1,
    borderColor: colors.line,
  },
  addText: { color: colors.ocean, fontSize: 12, fontWeight: '800' },
  composer: { paddingHorizontal: spacing.sm, paddingBottom: spacing.xs },
  list: { flex: 1 },
  listContent: { paddingBottom: spacing.xl },
  bucket: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingHorizontal: spacing.sm + 2,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  bucketOverdue: { color: colors.coralDeep },
  row: { paddingHorizontal: spacing.sm + 2, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', padding: spacing.lg },
  pressed: { opacity: 0.6 },
});
