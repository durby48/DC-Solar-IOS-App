import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { EmptyState, SkeletonList } from '@/components/ui';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  applyLabel,
  archiveThreads,
  composeParamsFor,
  fetchThread,
  gmailThreadUrl,
  markRead,
  markUnread,
  openInGmail,
  saveAttachment,
  starThreads,
  trashThreads,
  unarchiveThreads,
  unstarThreads,
  untrashThreads,
  type ComposeMode,
  type MailAttachment,
  type MailLabel,
  type MailMessage,
  type MailThread,
} from '@/lib/gmail';
import * as haptics from '@/lib/haptics';

import { composeRouteParams } from './composeStash';
import { attachmentIcon, formatSize, formatWhen, type IconName } from './format';
import { LabelPicker } from './LabelPicker';

/**
 * One conversation, oldest message first, with everything Gmail lets you do
 * to it: archive, star, mark unread, trash, move to a label, and Reply /
 * Reply all / Forward into the composer. Used full-screen by
 * `/inbox/[threadId]` and as the reading pane beside the list on wide web.
 *
 * OLDEST FIRST, NEWEST LAST. A mail thread is a transcript; the newest
 * message — the one you came for — ends up nearest your thumb. Read messages
 * start collapsed (header only), unread ones and the newest start open.
 *
 * BODIES ARE PLAIN TEXT AND SELECTABLE. The edge function hands back text,
 * so there is no WebView and no remote content: no tracking pixel fires
 * because the app opened a message.
 *
 * OPENING MARKS READ, like Gmail. The thread's UNREAD label comes off as soon
 * as it loads; Mark unread puts it back and steps out of the thread.
 */

export type ThreadChange =
  | 'read'
  | 'unread'
  | 'archived'
  | 'unarchived'
  | 'trashed'
  | 'untrashed'
  | 'starred'
  | 'unstarred'
  | 'labeled';

export function ThreadView({
  threadId,
  labels,
  embedded = false,
  onClose,
  onChanged,
  onLabelCreated,
}: {
  threadId: string;
  /** For Move to label. Empty is fine — the picker can create one. */
  labels: MailLabel[];
  /** Inside the wide inbox's reading pane: a Close instead of a Back. */
  embedded?: boolean;
  onClose?: () => void;
  /** The list beside/behind this should refresh or drop the row. */
  onChanged?: (change: ThreadChange, threadId: string) => void;
  onLabelCreated?: (label: MailLabel) => void;
}) {
  const router = useRouter();
  const [thread, setThread] = useState<MailThread | null>(null);
  const [mailbox, setMailbox] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAttachment, setBusyAttachment] = useState<string | null>(null);
  const [labelPicker, setLabelPicker] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await fetchThread(threadId);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      setThread(null);
      return;
    }
    setMailbox(result.mailbox);
    setThread(result.thread);
    const open = new Set<string>();
    const messages = result.thread.messages;
    messages.forEach((m, i) => {
      if (m.unread || i === messages.length - 1) open.add(m.id);
    });
    setExpanded(open);
    if (result.thread.unread) {
      // Gmail marks a conversation read when you open it; so do we. Fire and
      // forget — a failure here is invisible and harmless.
      void markRead([threadId]).then((r) => {
        if (r.ok) onChanged?.('read', threadId);
      });
      setThread({ ...result.thread, unread: false, messages: messages.map((m) => ({ ...m, unread: false })) });
    }
  }, [threadId, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const leave = () => {
    if (embedded) onClose?.();
    else if (router.canGoBack()) router.back();
    else router.replace('/inbox');
  };

  /** Run a mailbox change, patch local state, tell the list. */
  const act = async (
    key: string,
    run: () => Promise<{ ok: true } | { ok: false; message: string } | { ok: boolean; message?: string }>,
    change: ThreadChange,
    patch: (t: MailThread) => MailThread,
    leaveAfter: boolean,
  ) => {
    if (!thread || busy) return;
    setBusy(key);
    setActionError(null);
    haptics.tapMedium();
    const result = await run();
    setBusy(null);
    if (!result.ok) {
      setActionError('message' in result && result.message ? result.message : 'That did not work.');
      haptics.error();
      return;
    }
    setThread(patch(thread));
    onChanged?.(change, thread.id);
    if (leaveAfter) leave();
  };

  const compose = (mode: Exclude<ComposeMode, 'new'>, message: MailMessage) => {
    if (!thread) return;
    haptics.tapMedium();
    router.push({
      pathname: '/inbox/compose',
      params: composeRouteParams(composeParamsFor(mode, thread, message, mailbox)),
    });
  };

  const download = async (message: MailMessage, attachment: MailAttachment) => {
    setBusyAttachment(attachment.attachmentId);
    setActionError(null);
    const result = await saveAttachment({ messageId: message.id, attachment });
    setBusyAttachment(null);
    if (!result.ok) setActionError(result.message);
    else haptics.success();
  };

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  if (loading) {
    return (
      <View style={styles.fill}>
        <SkeletonList count={3} height={140} gap={spacing.md} radius={radii.md} />
      </View>
    );
  }

  if (error || !thread) {
    return (
      <View style={styles.fill}>
        <EmptyState
          icon="cloud-offline"
          title="Could not open that conversation"
          body={error ?? 'This conversation has no readable messages.'}
          action={{ label: 'Try again', onPress: () => void load() }}
        />
      </View>
    );
  }

  const newest = thread.messages[thread.messages.length - 1];
  const ids = [thread.id];

  return (
    <View style={styles.fill}>
      {/* ---- header actions ------------------------------------------------ */}
      <View style={styles.toolbar}>
        <IconButton
          icon={embedded ? 'close' : 'arrow-back'}
          label={embedded ? 'Close' : 'Back'}
          onPress={leave}
        />
        <View style={styles.toolbarSpacer} />
        {thread.inTrash ? (
          <IconButton
            icon="arrow-undo"
            label="Restore"
            busy={busy === 'untrash'}
            onPress={() =>
              void act('untrash', () => untrashThreads(ids), 'untrashed', (t) => ({ ...t, inTrash: false, inInbox: true }), true)
            }
          />
        ) : thread.inInbox ? (
          <IconButton
            icon="archive-outline"
            label="Archive"
            busy={busy === 'archive'}
            onPress={() =>
              void act('archive', () => archiveThreads(ids), 'archived', (t) => ({ ...t, inInbox: false }), true)
            }
          />
        ) : (
          <IconButton
            icon="mail-open-outline"
            label="Move to Inbox"
            busy={busy === 'unarchive'}
            onPress={() =>
              void act('unarchive', () => unarchiveThreads(ids), 'unarchived', (t) => ({ ...t, inInbox: true }), false)
            }
          />
        )}
        <IconButton
          icon={thread.starred ? 'star' : 'star-outline'}
          label={thread.starred ? 'Unstar' : 'Star'}
          tint={thread.starred ? colors.amber : undefined}
          busy={busy === 'star'}
          onPress={() =>
            thread.starred
              ? void act('star', () => unstarThreads(ids), 'unstarred', (t) => ({ ...t, starred: false }), false)
              : void act('star', () => starThreads(ids), 'starred', (t) => ({ ...t, starred: true }), false)
          }
        />
        <IconButton
          icon="mail-unread-outline"
          label="Mark unread"
          busy={busy === 'unread'}
          onPress={() => void act('unread', () => markUnread(ids), 'unread', (t) => ({ ...t, unread: true }), true)}
        />
        <IconButton icon="pricetag-outline" label="Move to label" onPress={() => setLabelPicker(true)} />
        {thread.inTrash ? null : (
          <IconButton
            icon="trash-outline"
            label="Trash"
            tint={colors.danger}
            busy={busy === 'trash'}
            onPress={() =>
              void act('trash', () => trashThreads(ids), 'trashed', (t) => ({ ...t, inTrash: true, inInbox: false }), true)
            }
          />
        )}
        <IconButton icon="open-outline" label="Open in Gmail" onPress={() => void openInGmail(gmailThreadUrl(thread.id))} />
      </View>

      <ScrollView style={styles.fill} contentContainerStyle={styles.content}>
        <Text style={styles.subject} selectable>
          {thread.subject}
        </Text>
        <Text style={styles.meta}>
          {thread.messages.length === 1 ? '1 message' : `${thread.messages.length} messages`}
          {thread.inTrash ? ' · in Trash' : thread.inInbox ? '' : ' · archived'}
          {mailbox ? ` · ${mailbox}` : ''}
        </Text>

        {actionError ? (
          <View style={styles.errorCard}>
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={styles.errorText}>{actionError}</Text>
          </View>
        ) : null}

        {thread.messages.map((message) => {
          const open = expanded.has(message.id);
          const ours = message.sent || (mailbox ? message.fromAddress.toLowerCase() === mailbox.toLowerCase() : false);
          return (
            <View key={message.id} style={[styles.message, !open && styles.messageCollapsed]}>
              <Pressable onPress={() => toggle(message.id)} style={styles.messageHeader} accessibilityRole="button">
                <View style={[styles.avatar, ours && styles.avatarOurs]}>
                  <Text style={styles.avatarText}>
                    {(message.fromName || message.fromAddress || '?').trim().charAt(0).toUpperCase()}
                  </Text>
                </View>
                <View style={styles.headerBody}>
                  <View style={styles.headerLine}>
                    <Text style={[styles.from, message.unread && styles.fromUnread]} numberOfLines={1}>
                      {ours ? 'You' : message.fromName || message.fromAddress || 'Unknown sender'}
                      {message.draft ? '  · draft' : ''}
                    </Text>
                    <Text style={styles.when}>{formatWhen(message.date)}</Text>
                  </View>
                  {open ? (
                    <>
                      <Text style={styles.address} numberOfLines={1} selectable>
                        {message.fromAddress}
                      </Text>
                      {message.to ? (
                        <Text style={styles.address} numberOfLines={2} selectable>
                          to {message.to}
                        </Text>
                      ) : null}
                      {message.cc ? (
                        <Text style={styles.address} numberOfLines={2} selectable>
                          cc {message.cc}
                        </Text>
                      ) : null}
                    </>
                  ) : (
                    <Text style={styles.collapsedSnippet} numberOfLines={1}>
                      {message.snippet || '(no text)'}
                    </Text>
                  )}
                </View>
                <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={16} color={colors.textMuted} />
              </Pressable>

              {open ? (
                <>
                  <Text style={styles.body} selectable>
                    {message.bodyText.trim() || message.snippet || '(no message body)'}
                  </Text>

                  {message.attachments.length > 0 ? (
                    <View style={styles.attachments}>
                      {message.attachments.map((attachment) => {
                        const downloading = busyAttachment === attachment.attachmentId;
                        return (
                          <Pressable
                            key={attachment.attachmentId}
                            onPress={() => void download(message, attachment)}
                            disabled={downloading}
                            style={({ pressed }) => [styles.attachment, pressed && !downloading && styles.pressed]}>
                            <View style={styles.attachmentIcon}>
                              {downloading ? (
                                <ActivityIndicator color={hubColors.crm.fg} size="small" />
                              ) : (
                                <Ionicons name={attachmentIcon(attachment.mimeType)} size={15} color={hubColors.crm.fg} />
                              )}
                            </View>
                            <View style={styles.attachmentBody}>
                              <Text style={styles.attachmentName} numberOfLines={1}>
                                {attachment.filename}
                              </Text>
                              <Text style={styles.attachmentSize}>{formatSize(attachment.size)}</Text>
                            </View>
                            <Ionicons name="download-outline" size={16} color={colors.accentLink} />
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}

                  <View style={styles.messageActions}>
                    <SmallAction icon="arrow-undo" label="Reply" onPress={() => compose('reply', message)} />
                    <SmallAction icon="arrow-undo-circle-outline" label="Reply all" onPress={() => compose('replyAll', message)} />
                    <SmallAction icon="arrow-redo" label="Forward" onPress={() => compose('forward', message)} />
                  </View>
                </>
              ) : null}
            </View>
          );
        })}

        {newest ? (
          <View style={styles.replyBar}>
            <Pressable
              onPress={() => compose('reply', newest)}
              style={({ pressed }) => [styles.replyButton, pressed && styles.pressed]}
              accessibilityRole="button">
              <Ionicons name="arrow-undo" size={16} color={colors.textInverse} />
              <Text style={styles.replyButtonText}>Reply</Text>
            </Pressable>
            <Pressable
              onPress={() => compose('replyAll', newest)}
              style={({ pressed }) => [styles.replyGhost, pressed && styles.pressed]}
              accessibilityRole="button">
              <Ionicons name="arrow-undo-circle-outline" size={16} color={hubColors.crm.fg} />
              <Text style={styles.replyGhostText}>Reply all</Text>
            </Pressable>
            <Pressable
              onPress={() => compose('forward', newest)}
              style={({ pressed }) => [styles.replyGhost, pressed && styles.pressed]}
              accessibilityRole="button">
              <Ionicons name="arrow-redo" size={16} color={hubColors.crm.fg} />
              <Text style={styles.replyGhostText}>Forward</Text>
            </Pressable>
          </View>
        ) : null}
      </ScrollView>

      {labelPicker ? (
        <LabelPicker
          visible
          labels={labels}
          inInbox={thread.inInbox}
          count={1}
          onClose={() => setLabelPicker(false)}
          onLabelCreated={onLabelCreated}
          onPick={(label, archive) => {
            setLabelPicker(false);
            void act(
              'label',
              () => applyLabel(ids, label.id, archive),
              'labeled',
              (t) => ({ ...t, inInbox: archive ? false : t.inInbox, labelIds: [...new Set([...t.labelIds, label.id])] }),
              archive,
            );
          }}
        />
      ) : null}
    </View>
  );
}

function IconButton({
  icon,
  label,
  onPress,
  tint,
  busy = false,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  tint?: string;
  busy?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={busy}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}>
      {busy ? (
        <ActivityIndicator size="small" color={hubColors.crm.fg} />
      ) : (
        <Ionicons name={icon} size={20} color={tint ?? colors.inkSoft} />
      )}
    </Pressable>
  );
}

function SmallAction({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.smallAction, pressed && styles.pressed]}>
      <Ionicons name={icon} size={14} color={hubColors.crm.fg} />
      <Text style={styles.smallActionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.surfaceAlt },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },

  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
  },
  toolbarSpacer: { flex: 1 },
  iconButton: { width: 38, height: 38, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },

  subject: { color: colors.ink, fontSize: 20, fontWeight: '800' },
  meta: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },

  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  errorText: { flex: 1, color: colors.danger, fontSize: 13, fontWeight: '700' },

  message: {
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  messageCollapsed: { paddingVertical: spacing.sm + 2 },
  messageHeader: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.slateSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOurs: { backgroundColor: hubColors.crm.bg },
  avatarText: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  headerBody: { flex: 1, gap: 1 },
  headerLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  from: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700' },
  fromUnread: { fontWeight: '800' },
  when: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  address: { color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  collapsedSnippet: { color: colors.textMuted, fontSize: 13, fontWeight: '500' },
  body: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '500',
    lineHeight: 21,
    marginTop: spacing.sm,
  },

  attachments: { gap: spacing.xs, marginTop: spacing.md },
  attachment: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surfaceSunk,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  attachmentIcon: {
    width: 28,
    height: 28,
    borderRadius: radii.sm,
    backgroundColor: hubColors.crm.bg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentBody: { flex: 1 },
  attachmentName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  attachmentSize: { color: colors.textMuted, fontSize: 11, fontWeight: '600' },

  messageActions: { flexDirection: 'row', gap: spacing.xs, flexWrap: 'wrap', marginTop: spacing.md },
  smallAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: colors.border,
  },
  smallActionText: { color: hubColors.crm.fg, fontSize: 12, fontWeight: '800' },

  replyBar: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.sm },
  replyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: hubColors.crm.fg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
  },
  replyButtonText: { color: colors.textInverse, fontSize: 14, fontWeight: '800' },
  replyGhost: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
  },
  replyGhostText: { color: hubColors.crm.fg, fontSize: 14, fontWeight: '800' },
  pressed: { opacity: 0.7 },
});
