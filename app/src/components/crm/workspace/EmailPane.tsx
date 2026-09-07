import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radii, spacing } from '@/constants/theme';
import { bareSubject, isOurAddress, type RecordEmailResult } from '@/lib/crmEmail';
import {
  fetchThread,
  gmailThreadUrl,
  openInGmail,
  saveAttachment,
  sendEmail,
  type InboxThread,
  type MailAttachment,
  type MailMessage,
  type MailThread,
} from '@/lib/gmail';
import { type WorkspaceRecord } from '@/lib/crmWorkspace';

/**
 * The Email side of the CRM's `SMS | Email` switch (Phase 7, 2026-09-07).
 *
 * Three views in one column, Chatwoot-style: the record's threads (newest
 * first, direction and unread state on the row), one thread (oldest first,
 * plain-text bodies, attachments you can download, a reply box at the
 * bottom), and a compose box for a fresh email. Everything is read live
 * from the caller's own Gmail mailbox and nothing is stored — see
 * lib/crmEmail.ts for why.
 *
 * Direction is decided by address: a message from the mapped mailbox (or
 * anything @dcsolarkc.com) is ours and sits on the right, like an SMS
 * bubble; everything else is theirs.
 *
 * Sending is honest. Until the Workspace admin adds the gmail.send scope the
 * function answers `scope_missing`, and that sentence is what the Send
 * button shows — the reply is not "sent" anywhere else.
 */

type PaneView = { kind: 'list' } | { kind: 'thread'; id: string } | { kind: 'compose' };

function when(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function relative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 2) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function EmailPane({
  record,
  email,
  openThreadId,
  onOpenThread,
  onChanged,
}: {
  record: WorkspaceRecord;
  /** null while the record's threads are loading. */
  email: RecordEmailResult | null;
  /** A thread the Activity tab asked to open. */
  openThreadId: string | null;
  onOpenThread: (id: string | null) => void;
  /** After a send: the list and the Activity need a fresh read. */
  onChanged: () => void;
}) {
  const [view, setView] = useState<PaneView>(openThreadId ? { kind: 'thread', id: openThreadId } : { kind: 'list' });
  const [thread, setThread] = useState<MailThread | null>(null);
  const [threadError, setThreadError] = useState<string | null>(null);
  const [threadLoading, setThreadLoading] = useState(false);
  const [busyAttachment, setBusyAttachment] = useState<string | null>(null);

  const [subject, setSubject] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentNote, setSentNote] = useState<string | null>(null);

  const mailbox = email?.status === 'ok' ? email.mailbox : null;

  // The Activity tab hands us a thread id; the record changing resets us.
  useEffect(() => {
    if (openThreadId) setView({ kind: 'thread', id: openThreadId });
  }, [openThreadId]);
  useEffect(() => {
    setView({ kind: 'list' });
    setThread(null);
    setDraft('');
    setSubject('');
    setSendError(null);
    setSentNote(null);
  }, [record.key]);

  const loadThread = useCallback(async (id: string) => {
    setThreadLoading(true);
    setThreadError(null);
    const result = await fetchThread(id);
    setThreadLoading(false);
    if (!result.ok) {
      setThreadError(result.message);
      setThread(null);
      return;
    }
    setThread(result.thread);
  }, []);

  useEffect(() => {
    if (view.kind === 'thread') void loadThread(view.id);
  }, [view, loadThread]);

  const open = (id: string) => {
    setSendError(null);
    setSentNote(null);
    setDraft('');
    setView({ kind: 'thread', id });
    onOpenThread(id);
  };
  const back = () => {
    setView({ kind: 'list' });
    setThread(null);
    setSendError(null);
    onOpenThread(null);
  };

  const download = async (message: MailMessage, attachment: MailAttachment) => {
    setBusyAttachment(attachment.attachmentId);
    const result = await saveAttachment({ messageId: message.id, attachment });
    setBusyAttachment(null);
    if (!result.ok) setThreadError(result.message);
  };

  /** Reply goes to whoever last wrote from their side; falls back to the record's address. */
  const replyTo = (): string => {
    const theirs = [...(thread?.messages ?? [])].reverse().find((m) => !isOurAddress(m.fromAddress, mailbox));
    return theirs?.fromAddress || record.email || '';
  };

  const sendReply = async () => {
    if (!thread || !draft.trim()) return;
    const newest = thread.messages[thread.messages.length - 1];
    setSending(true);
    setSendError(null);
    const result = await sendEmail({
      to: replyTo(),
      subject: /^re:/i.test(thread.subject.trim()) ? thread.subject.trim() : `Re: ${thread.subject.trim()}`,
      text: draft,
      threadId: thread.id,
      inReplyTo: newest?.rfcMessageId || null,
      references: newest ? [newest.references, newest.rfcMessageId].filter(Boolean).join(' ') : null,
    });
    setSending(false);
    if (!result.ok) {
      setSendError(result.message);
      return;
    }
    setDraft('');
    setSentNote(`Sent from ${result.mailbox}`);
    await loadThread(thread.id);
    onChanged();
  };

  const sendNew = async () => {
    if (!record.email) return;
    setSending(true);
    setSendError(null);
    const result = await sendEmail({ to: record.email, subject, text: draft });
    setSending(false);
    if (!result.ok) {
      setSendError(result.message);
      return;
    }
    setDraft('');
    setSubject('');
    setSentNote(`Sent from ${result.mailbox}`);
    onChanged();
    if (result.threadId) open(result.threadId);
    else setView({ kind: 'list' });
  };

  // ----- states that end the pane early --------------------------------------

  if (email === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.ocean} />
        <Text style={styles.muted}>Looking for email with {record.name}…</Text>
      </View>
    );
  }
  if (email.status === 'no_email') {
    return (
      <View style={styles.center}>
        <Ionicons name="mail-outline" size={22} color={colors.inkSoft} />
        <Text style={styles.emptyTitle}>No email address on this {record.kind}</Text>
        <Text style={styles.emptyBody}>Add one in the details panel and every thread with them shows up here.</Text>
      </View>
    );
  }
  if (email.status === 'no_mailbox') {
    return (
      <View style={styles.center}>
        <Ionicons name="lock-closed-outline" size={22} color={colors.inkSoft} />
        <Text style={styles.emptyTitle}>No mailbox is linked to your account</Text>
        <Text style={styles.emptyBody}>
          Email in the CRM reads your own dcsolarkc.com mailbox. Only accounts mapped in the gmail-inbox function
          (Devon, Isaiah today) have one — docs/GMAIL_INBOX_SETUP.md says how to add another.
        </Text>
      </View>
    );
  }
  if (email.status === 'unavailable') {
    return (
      <View style={styles.center}>
        <Ionicons name="cloud-offline-outline" size={22} color={colors.inkSoft} />
        <Text style={styles.emptyTitle}>Mail is unavailable</Text>
        <Text style={styles.emptyBody}>{email.message}</Text>
        <Pressable onPress={onChanged} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonText}>Try again</Text>
        </Pressable>
      </View>
    );
  }

  // ----- compose ---------------------------------------------------------------

  if (view.kind === 'compose') {
    return (
      <View style={styles.column}>
        <View style={styles.bar}>
          <Pressable onPress={back} hitSlop={8} style={styles.barButton}>
            <Ionicons name="chevron-back" size={16} color={colors.ocean} />
            <Text style={styles.barButtonText}>Threads</Text>
          </Pressable>
          <Text style={styles.barTitle} numberOfLines={1}>
            New email · from {email.mailbox}
          </Text>
        </View>
        <ScrollView contentContainerStyle={styles.composeBody} keyboardShouldPersistTaps="handled">
          <Text style={styles.label}>To</Text>
          <Text style={styles.fixed}>{record.email}</Text>
          <Text style={styles.label}>Subject</Text>
          <TextInput value={subject} onChangeText={setSubject} placeholder="Subject" placeholderTextColor={colors.inkSoft} style={styles.input} />
          <Text style={styles.label}>Message</Text>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Hi ${record.name.split(' ')[0]},`}
            placeholderTextColor={colors.inkSoft}
            multiline
            style={[styles.input, styles.bodyInput]}
          />
          {sendError ? <Text style={styles.error}>{sendError}</Text> : null}
          <View style={styles.composeActions}>
            <Pressable onPress={() => void sendNew()} disabled={sending || !draft.trim()} style={({ pressed }) => [styles.send, (pressed || sending || !draft.trim()) && styles.pressed]}>
              {sending ? <ActivityIndicator color={colors.ink} size="small" /> : <Text style={styles.sendText}>Send</Text>}
            </Pressable>
          </View>
        </ScrollView>
      </View>
    );
  }

  // ----- one thread --------------------------------------------------------------

  if (view.kind === 'thread') {
    return (
      <View style={styles.column}>
        <View style={styles.bar}>
          <Pressable onPress={back} hitSlop={8} style={styles.barButton}>
            <Ionicons name="chevron-back" size={16} color={colors.ocean} />
            <Text style={styles.barButtonText}>Threads</Text>
          </Pressable>
          <Text style={styles.barTitle} numberOfLines={1}>
            {thread?.subject ?? 'Loading…'}
          </Text>
          <Pressable onPress={() => void openInGmail(gmailThreadUrl(view.id))} hitSlop={8} accessibilityLabel="Open in Gmail">
            <Ionicons name="open-outline" size={16} color={colors.ocean} />
          </Pressable>
        </View>
        {threadLoading && !thread ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.ocean} />
          </View>
        ) : threadError && !thread ? (
          <View style={styles.center}>
            <Text style={styles.emptyBody}>{threadError}</Text>
            <Pressable onPress={() => void loadThread(view.id)} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
              <Text style={styles.buttonText}>Try again</Text>
            </Pressable>
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.messages} keyboardShouldPersistTaps="handled">
            {thread?.messages.map((m) => {
              const ours = m.sent || isOurAddress(m.fromAddress, mailbox);
              return (
                <View key={m.id} style={[styles.message, ours ? styles.messageOurs : styles.messageTheirs]}>
                  <View style={styles.messageHead}>
                    <Text style={styles.messageFrom} numberOfLines={1}>
                      {ours ? `You · ${m.fromAddress}` : m.fromName || m.fromAddress}
                    </Text>
                    <Text style={styles.messageWhen}>{when(m.date)}</Text>
                  </View>
                  {m.to ? (
                    <Text style={styles.messageTo} numberOfLines={1}>
                      to {m.to}
                      {m.cc ? ` · cc ${m.cc}` : ''}
                    </Text>
                  ) : null}
                  <Text style={styles.messageBody} selectable>
                    {m.bodyText || m.snippet || '(no text)'}
                  </Text>
                  {m.attachments.length ? (
                    <View style={styles.attachments}>
                      {m.attachments.map((a) => (
                        <Pressable
                          key={a.attachmentId}
                          onPress={() => void download(m, a)}
                          disabled={busyAttachment === a.attachmentId}
                          style={({ pressed }) => [styles.attachment, pressed && styles.pressed]}>
                          {busyAttachment === a.attachmentId ? (
                            <ActivityIndicator size="small" color={colors.ocean} />
                          ) : (
                            <Ionicons name={a.mimeType.startsWith('image/') ? 'image-outline' : 'document-attach-outline'} size={14} color={colors.ocean} />
                          )}
                          <Text style={styles.attachmentText} numberOfLines={1}>
                            {a.filename}
                            {size(a.size) ? ` · ${size(a.size)}` : ''}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              );
            })}
            {threadError ? <Text style={styles.error}>{threadError}</Text> : null}
          </ScrollView>
        )}
        <View style={styles.replyBox}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Reply to ${replyTo() || record.name}…`}
            placeholderTextColor={colors.inkSoft}
            multiline
            style={[styles.input, styles.replyInput]}
          />
          <View style={styles.replyActions}>
            {sendError ? (
              <Text style={styles.error}>{sendError}</Text>
            ) : sentNote ? (
              <Text style={styles.sent}>{sentNote}</Text>
            ) : (
              <Text style={styles.muted} numberOfLines={1}>
                Sends as {email.mailbox}
              </Text>
            )}
            <Pressable onPress={() => void sendReply()} disabled={sending || !draft.trim() || !thread} style={({ pressed }) => [styles.send, (pressed || sending || !draft.trim()) && styles.pressed]}>
              {sending ? <ActivityIndicator color={colors.ink} size="small" /> : <Text style={styles.sendText}>Reply</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  // ----- the list ------------------------------------------------------------------

  const threads: InboxThread[] = email.threads;
  return (
    <View style={styles.column}>
      <View style={styles.bar}>
        <Text style={styles.barTitle} numberOfLines={1}>
          {threads.length ? `${threads.length} thread${threads.length === 1 ? '' : 's'} with ${record.email}` : record.email}
        </Text>
        <Text style={styles.mailbox} numberOfLines={1}>
          {email.mailbox}
        </Text>
        <Pressable
          onPress={() => {
            setSendError(null);
            setSentNote(null);
            setView({ kind: 'compose' });
          }}
          style={({ pressed }) => [styles.compose, pressed && styles.pressed]}
          accessibilityLabel="New email">
          <Ionicons name="create-outline" size={14} color={colors.ink} />
          <Text style={styles.composeText}>New</Text>
        </Pressable>
      </View>
      {sentNote ? <Text style={[styles.sent, styles.sentBanner]}>{sentNote}</Text> : null}
      <ScrollView contentContainerStyle={styles.list}>
        {threads.length === 0 ? (
          <View style={styles.center}>
            <Ionicons name="mail-outline" size={22} color={colors.inkSoft} />
            <Text style={styles.emptyTitle}>No email with {record.name} yet</Text>
            <Text style={styles.emptyBody}>Nothing in {email.mailbox} is from or to {record.email}. Start one with New.</Text>
          </View>
        ) : (
          threads.map((t) => {
            const out = isOurAddress(t.fromAddress, email.mailbox);
            return (
              <Pressable key={t.id} onPress={() => open(t.id)} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
                <View style={[styles.dot, t.unread && styles.dotUnread]} />
                <View style={styles.rowBody}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.rowSubject, t.unread && styles.rowSubjectUnread]} numberOfLines={1}>
                      {bareSubject(t.subject)}
                    </Text>
                    {t.messageCount > 1 ? <Text style={styles.count}>{t.messageCount}</Text> : null}
                    {t.hasAttachments ? <Ionicons name="attach" size={13} color={colors.inkSoft} /> : null}
                    <Text style={styles.rowTime}>{relative(t.date)}</Text>
                  </View>
                  <Text style={styles.rowSnippet} numberOfLines={2}>
                    <Text style={styles.rowWho}>{out ? 'You: ' : `${t.fromName}: `}</Text>
                    {t.snippet || '—'}
                  </Text>
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  column: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  muted: { color: colors.inkSoft, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  emptyTitle: { color: colors.ink, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.inkSoft, fontSize: 13, fontWeight: '600', textAlign: 'center', lineHeight: 18, maxWidth: 380 },
  button: { marginTop: spacing.xs, backgroundColor: colors.sun, borderRadius: 999, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  buttonText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  barButton: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  barButtonText: { color: colors.ocean, fontSize: 13, fontWeight: '700' },
  barTitle: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '700' },
  mailbox: { color: colors.inkSoft, fontSize: 11, fontWeight: '600', maxWidth: 160 },
  compose: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.sm + 2, paddingVertical: 5 },
  composeText: { color: colors.ink, fontSize: 12, fontWeight: '800' },
  list: { paddingBottom: spacing.xl },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    backgroundColor: colors.white,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  rowPressed: { backgroundColor: colors.skySoft },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6, backgroundColor: 'transparent' },
  dotUnread: { backgroundColor: colors.ocean },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  rowSubject: { flex: 1, color: colors.ink, fontSize: 13, fontWeight: '600' },
  rowSubjectUnread: { fontWeight: '800' },
  count: { color: colors.inkSoft, fontSize: 10, fontWeight: '800', backgroundColor: colors.canvas, borderRadius: radii.pill, paddingHorizontal: 6, paddingVertical: 1, overflow: 'hidden' },
  rowTime: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  rowSnippet: { color: colors.inkSoft, fontSize: 12, fontWeight: '500', lineHeight: 16 },
  rowWho: { color: colors.ink, fontWeight: '700' },
  messages: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.lg },
  message: { borderRadius: radii.md, padding: spacing.sm + 2, gap: 4, maxWidth: '92%' },
  messageOurs: { alignSelf: 'flex-end', backgroundColor: colors.skySoft },
  messageTheirs: { alignSelf: 'flex-start', backgroundColor: colors.white, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  messageHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  messageFrom: { flex: 1, color: colors.ink, fontSize: 12, fontWeight: '800' },
  messageWhen: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  messageTo: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  messageBody: { color: colors.ink, fontSize: 13, fontWeight: '500', lineHeight: 19 },
  attachments: { gap: 4, marginTop: 4 },
  attachment: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: colors.canvas, borderRadius: radii.sm, paddingHorizontal: spacing.sm, paddingVertical: 6 },
  attachmentText: { flex: 1, color: colors.ocean, fontSize: 12, fontWeight: '700' },
  replyBox: { padding: spacing.sm, gap: spacing.xs, backgroundColor: colors.white, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  replyActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  input: {
    backgroundColor: colors.canvas,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.sm,
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
  },
  replyInput: { minHeight: 64, maxHeight: 180, textAlignVertical: 'top' },
  bodyInput: { minHeight: 180, textAlignVertical: 'top' },
  composeBody: { padding: spacing.md, gap: spacing.xs },
  composeActions: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: spacing.sm },
  label: { color: colors.inkSoft, fontSize: 10, fontWeight: '800', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: spacing.xs },
  fixed: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  send: { backgroundColor: colors.sun, borderRadius: radii.pill, paddingHorizontal: spacing.lg, paddingVertical: 7, minWidth: 80, alignItems: 'center' },
  sendText: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  error: { flex: 1, color: colors.danger, fontSize: 12, fontWeight: '700' },
  sent: { flex: 1, color: colors.olive, fontSize: 12, fontWeight: '700' },
  sentBanner: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs, backgroundColor: colors.oliveSoft },
  pressed: { opacity: 0.6 },
});
