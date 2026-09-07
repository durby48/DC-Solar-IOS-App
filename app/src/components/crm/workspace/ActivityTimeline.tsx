import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, SectionList, StyleSheet, Text, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { groupByDay, type ActivityEvent, type ActivityKind } from '@/lib/crmWorkspace';

/**
 * The unified timeline: one row per thing that happened, grouped by day,
 * newest first. Twenty's timeline shape — actor · action · target · time —
 * with the icon carrying the channel so a glance tells texts from calls from
 * money from notes.
 *
 * Reads only. Every row is a projection of a row that lives in its own table
 * (`lib/crmWorkspace.ts::composeActivity`); nothing here writes.
 */

const ICONS: Record<ActivityKind, { name: keyof typeof Ionicons.glyphMap; fg: string; bg: string }> = {
  sms_in: { name: 'chatbubble', fg: colors.ocean, bg: colors.skySoft },
  sms_out: { name: 'chatbubble-outline', fg: colors.ocean, bg: colors.skySoft },
  call: { name: 'call', fg: colors.tealDeep, bg: colors.tealSoft },
  note: { name: 'document-text', fg: colors.amberDeep, bg: colors.amberSoft },
  job_created: { name: 'hammer', fg: colors.olive, bg: colors.oliveSoft },
  job_scheduled: { name: 'calendar', fg: colors.olive, bg: colors.oliveSoft },
  job_completed: { name: 'checkmark-circle', fg: colors.cream, bg: colors.olive },
  job_stage: { name: 'swap-horizontal', fg: colors.olive, bg: colors.oliveSoft },
  lead_status: { name: 'flag', fg: colors.amberDeep, bg: colors.amberSoft },
  task_added: { name: 'checkbox-outline', fg: colors.indigoDeep, bg: colors.indigoSoft },
  task_done: { name: 'checkbox', fg: colors.mintDeep, bg: colors.mintSoft },
  appointment: { name: 'calendar-outline', fg: colors.violetDeep, bg: colors.violetSoft },
  email_in: { name: 'mail', fg: colors.indigoDeep, bg: colors.indigoSoft },
  email_out: { name: 'mail-open-outline', fg: colors.indigoDeep, bg: colors.indigoSoft },
  estimate: { name: 'receipt', fg: colors.indigoDeep, bg: colors.indigoSoft },
  contract: { name: 'create', fg: colors.violetDeep, bg: colors.violetSoft },
  invoice: { name: 'cash', fg: colors.coralDeep, bg: colors.coralSoft },
  payment: { name: 'cash', fg: colors.mintDeep, bg: colors.mintSoft },
  lead_created: { name: 'person-add', fg: colors.amberDeep, bg: colors.amberSoft },
};

function clock(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function ActivityTimeline({
  events,
  emptyText,
  onOpenEmail,
}: {
  events: ActivityEvent[];
  emptyText?: string;
  /** Email rows open their Gmail thread in the Email pane. */
  onOpenEmail?: (threadId: string) => void;
}) {
  const router = useRouter();
  const sections = groupByDay(events);

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      style={styles.list}
      contentContainerStyle={styles.content}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => <Text style={styles.day}>{section.title}</Text>}
      renderItem={({ item }) => {
        const icon = ICONS[item.kind];
        const body = (
          <>
            <View style={[styles.icon, { backgroundColor: icon.bg }]}>
              <Ionicons name={icon.name} size={14} color={icon.fg} />
            </View>
            <View style={styles.body}>
              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {item.title}
                  {item.actor ? <Text style={styles.actor}> · {item.actor}</Text> : null}
                </Text>
                <Text style={styles.time}>{clock(item.at)}</Text>
              </View>
              {item.detail ? (
                <Text style={styles.detail} numberOfLines={3}>
                  {item.detail}
                </Text>
              ) : null}
            </View>
          </>
        );
        if (item.emailThreadId && onOpenEmail) {
          const threadId = item.emailThreadId;
          return (
            <Pressable onPress={() => onOpenEmail(threadId)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              {body}
            </Pressable>
          );
        }
        if (item.jobId && (item.kind.startsWith('job_') || item.kind === 'estimate' || item.kind === 'invoice' || item.kind === 'contract' || item.kind === 'payment')) {
          return (
            <Pressable
              onPress={() => router.push({ pathname: '/job/[id]', params: { id: item.jobId as string } })}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
              {body}
            </Pressable>
          );
        }
        return <View style={styles.row}>{body}</View>;
      }}
      ListEmptyComponent={
        <Text style={styles.empty}>{emptyText ?? 'Nothing has happened with this record yet.'}</Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  list: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl },
  day: {
    color: colors.inkSoft,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderRadius: radii.sm,
  },
  rowPressed: { backgroundColor: colors.skySoft },
  icon: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  body: { flex: 1, gap: 2 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '700' },
  actor: { color: colors.inkSoft, fontWeight: '600' },
  time: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  detail: { color: colors.inkSoft, fontSize: 13, fontWeight: '500', lineHeight: 18 },
  empty: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', padding: spacing.lg },
});
