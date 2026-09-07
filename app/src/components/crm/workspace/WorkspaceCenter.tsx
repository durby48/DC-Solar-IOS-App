import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { ActivityTimeline } from '@/components/crm/workspace/ActivityTimeline';
import { EmailPane } from '@/components/crm/workspace/EmailPane';
import { Conversation } from '@/components/comms/Conversation';
import { colors, radii, spacing } from '@/constants/theme';
import {
  buildTemplateVars,
  formatPhone,
  type CommsSettings,
  type MessageTemplate,
} from '@/lib/comms';
import { addCustomerNote, type CustomerNote } from '@/lib/crm';
import { type RecordEmailResult } from '@/lib/crmEmail';
import { Chip } from '@/components/ui';
import { type ActivityEvent, type ActivityKind, type WorkspaceRecord } from '@/lib/crmWorkspace';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * The middle column: the relationship's communication, three ways.
 *
 *   Conversation — the existing SMS/call thread and composer
 *                  (`components/comms/Conversation`, the same component the
 *                  Phone section and the customer record render), or — the
 *                  Email side of the switch — the record's Gmail threads,
 *                  read live from the caller's own mailbox with reply and
 *                  compose (`EmailPane`, Phase 7).
 *   Activity     — the unified timeline: texts, calls, notes, jobs, money,
 *                  all in one chronology.
 *   Notes        — the internal notes, with a box to add one.
 *
 * Pattern: Chatwoot's ConversationView + channel switch, with Twenty's
 * timeline as a sibling tab rather than interleaved into the chat — mixing
 * "Invoice sent" cards into text bubbles was the thing GoHighLevel gets
 * wrong for this crew.
 */

type Pane = 'conversation' | 'activity' | 'notes';
type Channel = 'sms' | 'email';

/**
 * Activity lenses (Phase 8). Forty-five rows for a long customer is a wall;
 * Twenty's timeline solves it with per-type filters, so: one chip per group
 * that actually has rows, counts on the chips, "All" first.
 */
type ActivityFilter = 'all' | 'comms' | 'email' | 'money' | 'jobs' | 'notes' | 'followups';
const ACTIVITY_GROUPS: { key: Exclude<ActivityFilter, 'all'>; label: string; kinds: ActivityKind[] }[] = [
  { key: 'comms', label: 'Texts & calls', kinds: ['sms_in', 'sms_out', 'call'] },
  { key: 'email', label: 'Email', kinds: ['email_in', 'email_out'] },
  { key: 'money', label: 'Money', kinds: ['estimate', 'contract', 'invoice', 'payment'] },
  { key: 'jobs', label: 'Jobs', kinds: ['job_created', 'job_scheduled', 'job_completed', 'job_stage'] },
  { key: 'notes', label: 'Notes', kinds: ['note'] },
  { key: 'followups', label: 'Tasks & visits', kinds: ['task_added', 'task_done', 'appointment', 'lead_created', 'lead_status'] },
];

function noteTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function authorName(email: string): string {
  const local = email.split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : 'Someone';
}

export function WorkspaceCenter({
  record,
  settings,
  templates,
  tech,
  notes,
  notesAvailable,
  events,
  loading,
  email,
  onNotesChanged,
  onEmailChanged,
  onOpenDetail,
}: {
  record: WorkspaceRecord;
  settings: CommsSettings | null;
  templates: MessageTemplate[];
  tech: string | null;
  notes: CustomerNote[];
  notesAvailable: boolean;
  events: ActivityEvent[];
  loading: boolean;
  /** The record's Gmail threads (null while loading). */
  email: RecordEmailResult | null;
  onNotesChanged: () => void;
  onEmailChanged: () => void;
  /** Narrow layouts: the detail column lives behind this. */
  onOpenDetail?: () => void;
}) {
  const router = useRouter();
  const [pane, setPane] = useState<Pane>('conversation');
  const [channel, setChannel] = useState<Channel>('sms');
  const [emailThreadId, setEmailThreadId] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');

  const groupCounts = useMemo(() => {
    const counts = new Map<ActivityFilter, number>();
    for (const g of ACTIVITY_GROUPS) counts.set(g.key, events.filter((e) => g.kinds.includes(e.kind)).length);
    return counts;
  }, [events]);
  const filteredEvents = useMemo(() => {
    if (activityFilter === 'all') return events;
    const kinds = ACTIVITY_GROUPS.find((g) => g.key === activityFilter)?.kinds ?? [];
    return events.filter((e) => kinds.includes(e.kind));
  }, [events, activityFilter]);
  const emailCount = email?.status === 'ok' ? email.threads.length : 0;
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  const smsReady = settings?.smsEnabled === true;
  const phone = record.phoneE164;
  const templateVars = buildTemplateVars({
    customer: record.customer ?? (record.lead ? { name: record.lead.name, address: record.lead.address } : null),
    job: record.currentJob
      ? { job_number: record.currentJob.job_number, address: null, scheduled_for: record.currentJob.scheduled_for }
      : null,
    settings,
    tech,
  });

  const openRecord = () => {
    if (record.kind === 'customer') {
      router.push({ pathname: '/crm/[id]', params: { id: record.id } });
    } else {
      router.push({ pathname: '/leads/[id]', params: { id: record.id } } as never);
    }
  };

  const call = () => {
    if (!phone) return;
    const params: Record<string, string> = { to: phone, name: record.name };
    if (record.kind === 'customer') params.customerId = record.id;
    router.push({ pathname: inAppCallingSupported() ? '/call' : '/messages/thread', params } as never);
  };

  const submitNote = async () => {
    if (record.kind !== 'customer') return;
    const body = noteDraft.trim();
    if (!body) return;
    setSavingNote(true);
    setNoteError(null);
    const result = await addCustomerNote({ customerId: record.id, body, jobId: record.currentJob?.id ?? null });
    setSavingNote(false);
    if (result.ok) {
      setNoteDraft('');
      onNotesChanged();
    } else {
      setNoteError(result.message);
    }
  };

  const header = (
    <View style={styles.header}>
      <View style={styles.headerBody}>
        <Text style={styles.headerName} numberOfLines={1}>
          {record.name}
        </Text>
        <Text style={styles.headerMeta} numberOfLines={1}>
          {record.kind === 'lead' ? 'Lead' : 'Customer'}
          {phone ? ` · ${formatPhone(phone)}` : ' · no phone on file'}
          {record.currentJob ? ` · ${record.currentJob.job_number ?? record.currentJob.name}` : ''}
        </Text>
      </View>
      <Pressable
        onPress={call}
        disabled={!phone}
        accessibilityLabel="Call"
        style={({ pressed }) => [styles.headerButton, !phone && styles.headerButtonMuted, pressed && styles.pressed]}>
        <Ionicons name="call" size={15} color={phone ? colors.ink : colors.inkSoft} />
      </Pressable>
      <Pressable
        onPress={openRecord}
        accessibilityLabel="Open full record"
        style={({ pressed }) => [styles.headerButton, styles.headerButtonSecondary, pressed && styles.pressed]}>
        <Ionicons name="open-outline" size={15} color={colors.ocean} />
      </Pressable>
      {onOpenDetail ? (
        <Pressable
          onPress={onOpenDetail}
          accessibilityLabel="Details"
          style={({ pressed }) => [styles.headerButton, styles.headerButtonSecondary, pressed && styles.pressed]}>
          <Ionicons name="information-circle-outline" size={17} color={colors.ocean} />
        </Pressable>
      ) : null}
    </View>
  );

  const tabs = (
    <View style={styles.tabs}>
      {(
        [
          ['conversation', 'Conversation'],
          ['activity', `Activity${events.length ? ` ${events.length}` : ''}`],
          ['notes', `Notes${notes.length ? ` ${notes.length}` : ''}`],
        ] as [Pane, string][]
      ).map(([key, label]) => (
        <Pressable
          key={key}
          onPress={() => setPane(key)}
          style={({ pressed }) => [styles.tab, pane === key && styles.tabActive, pressed && styles.pressed]}>
          <Text style={[styles.tabText, pane === key && styles.tabTextActive]}>{label}</Text>
        </Pressable>
      ))}
      {pane === 'conversation' ? (
        <View style={styles.channelSwitch}>
          <Pressable
            onPress={() => setChannel('sms')}
            style={[styles.channel, channel === 'sms' && styles.channelActive]}>
            <Text style={[styles.channelText, channel === 'sms' && styles.channelTextActive]}>SMS</Text>
          </Pressable>
          <Pressable
            onPress={() => setChannel('email')}
            style={[styles.channel, channel === 'email' && styles.channelActive]}>
            <Text style={[styles.channelText, channel === 'email' && styles.channelTextActive]}>
              Email{emailCount ? ` ${emailCount}` : ''}
            </Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  let body: React.ReactNode;
  if (loading) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={colors.ocean} />
      </View>
    );
  } else if (pane === 'conversation') {
    body =
      channel === 'email' ? (
        <EmailPane
          key={record.key}
          record={record}
          email={email}
          openThreadId={emailThreadId}
          onOpenThread={setEmailThreadId}
          onChanged={onEmailChanged}
        />
      ) : !phone && record.kind === 'lead' ? (
        <View style={styles.center}>
          <Ionicons name="chatbubbles-outline" size={22} color={colors.inkSoft} />
          <Text style={styles.emptyTitle}>No phone number on this lead</Text>
          <Text style={styles.emptyBody}>Add one in the details panel and the thread appears here.</Text>
        </View>
      ) : (
        <Conversation
          key={record.key}
          target={
            record.kind === 'customer'
              ? { customerId: record.id, phone }
              : { leadId: record.id, phone }
          }
          name={record.name}
          smsReady={smsReady && Boolean(phone)}
          optedOut={record.optedOut}
          optedOutAt={record.customer?.sms_opt_out_at ?? null}
          jobId={record.currentJob?.id ?? null}
          templates={templates}
          templateVars={templateVars}
          keyboardOffset={0}
        />
      );
  } else if (pane === 'activity') {
    const groups = ACTIVITY_GROUPS.filter((g) => (groupCounts.get(g.key) ?? 0) > 0);
    body = (
      <View style={styles.activity}>
        {groups.length > 1 ? (
          <View style={styles.filterRow}>
            <Chip label={`All ${events.length}`} tone="ocean" selected={activityFilter === 'all'} onPress={() => setActivityFilter('all')} />
            {groups.map((g) => (
              <Chip
                key={g.key}
                label={`${g.label} ${groupCounts.get(g.key) ?? 0}`}
                tone="ocean"
                selected={activityFilter === g.key}
                onPress={() => setActivityFilter(activityFilter === g.key ? 'all' : g.key)}
              />
            ))}
          </View>
        ) : null}
        <ActivityTimeline
          events={filteredEvents}
          onOpenEmail={(threadId) => {
            setEmailThreadId(threadId);
            setChannel('email');
            setPane('conversation');
          }}
          emptyText={
            activityFilter !== 'all'
              ? 'Nothing of that kind yet.'
              : record.kind === 'lead'
                ? 'Nothing beyond the lead being created. Texts, calls and notes will show here.'
                : 'Nothing has happened with this customer yet.'
          }
        />
      </View>
    );
  } else {
    body = (
      <ScrollView style={styles.notes} contentContainerStyle={styles.notesContent} keyboardShouldPersistTaps="handled">
        {record.kind === 'customer' ? (
          <View style={styles.noteBox}>
            <TextInput
              value={noteDraft}
              onChangeText={setNoteDraft}
              placeholder="Gate code, dog, who to call…"
              placeholderTextColor={colors.inkSoft}
              multiline
              style={styles.noteInput}
            />
            <View style={styles.noteActions}>
              {noteError ? <Text style={styles.noteError}>{noteError}</Text> : <View />}
              <Pressable
                onPress={() => void submitNote()}
                disabled={savingNote || !noteDraft.trim()}
                style={({ pressed }) => [styles.noteSave, (pressed || savingNote || !noteDraft.trim()) && styles.pressed]}>
                {savingNote ? <ActivityIndicator color={colors.ink} size="small" /> : <Text style={styles.noteSaveText}>Add note</Text>}
              </Pressable>
            </View>
          </View>
        ) : (
          <View style={styles.noteCard}>
            <Text style={styles.noteBody}>{record.lead?.notes?.trim() || 'No notes on this lead.'}</Text>
            <Text style={styles.noteMeta}>Lead notes are edited on the lead record (open it from the header).</Text>
          </View>
        )}
        {record.kind === 'customer' && record.customer?.notes ? (
          <View style={[styles.noteCard, styles.notePinned]}>
            <Text style={styles.noteBody}>{record.customer.notes}</Text>
            <Text style={styles.noteMeta}>General notes on the customer record</Text>
          </View>
        ) : null}
        {!notesAvailable && record.kind === 'customer' ? (
          <Text style={styles.emptyBody}>Notes could not be loaded right now.</Text>
        ) : null}
        {notes.map((n) => (
          <View key={n.id} style={[styles.noteCard, n.pinned && styles.notePinned]}>
            <Text style={styles.noteBody}>{n.body}</Text>
            <Text style={styles.noteMeta}>
              {n.pinned ? 'Pinned · ' : ''}
              {authorName(n.author_email)} · {noteTime(n.created_at)}
            </Text>
          </View>
        ))}
        {record.kind === 'customer' && notesAvailable && notes.length === 0 && !record.customer?.notes ? (
          <Text style={styles.emptyBody}>No notes yet.</Text>
        ) : null}
      </ScrollView>
    );
  }

  return (
    <View style={styles.column}>
      {header}
      {tabs}
      <View style={styles.paneBody}>{body}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, backgroundColor: colors.cream },
  activity: { flex: 1 },
  filterRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  headerBody: { flex: 1, gap: 1 },
  headerName: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  headerMeta: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
  headerButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.sun,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerButtonSecondary: { backgroundColor: colors.skySoft },
  headerButtonMuted: { backgroundColor: colors.slateSoft },
  tabs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  tab: { paddingHorizontal: spacing.sm + 2, paddingVertical: 6, borderRadius: radii.pill },
  tabActive: { backgroundColor: colors.oliveSoft },
  tabText: { color: colors.inkSoft, fontSize: 13, fontWeight: '700' },
  tabTextActive: { color: colors.oliveDeep },
  channelSwitch: {
    marginLeft: 'auto',
    flexDirection: 'row',
    backgroundColor: colors.canvas,
    borderRadius: radii.pill,
    padding: 2,
    borderWidth: 1,
    borderColor: colors.line,
  },
  channel: { paddingHorizontal: spacing.sm + 2, paddingVertical: 4, borderRadius: radii.pill },
  channelActive: { backgroundColor: colors.white },
  channelText: { color: colors.inkSoft, fontSize: 12, fontWeight: '800' },
  channelTextActive: { color: colors.ink },
  paneBody: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  emptyTitle: { color: colors.ink, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', lineHeight: 18 },
  notes: { flex: 1 },
  notesContent: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xl },
  noteBox: { backgroundColor: colors.white, borderRadius: radii.md, padding: spacing.sm, gap: spacing.sm },
  noteInput: {
    minHeight: 64,
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.sm + 2,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  noteActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  noteError: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  noteSave: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.md, paddingVertical: 6, minWidth: 90, alignItems: 'center' },
  noteSaveText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  noteCard: { backgroundColor: colors.white, borderRadius: radii.md, padding: spacing.md, gap: spacing.xs },
  notePinned: { backgroundColor: colors.amberSoft },
  noteBody: { color: colors.ink, fontSize: 14, fontWeight: '500', lineHeight: 20 },
  noteMeta: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
