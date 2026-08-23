import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { EmptyState, SkeletonList } from '@/components/ui';
import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  fetchThread,
  gmailReplyUrl,
  gmailThreadUrl,
  openInGmail,
  saveAttachment,
  type MailAttachment,
  type MailMessage,
  type MailThread,
} from '@/lib/gmail';
import * as haptics from '@/lib/haptics';
import { useRoleGate } from '@/lib/role';

/**
 * `/inbox/[threadId]` — one conversation, oldest message first.
 *
 * OLDEST FIRST, NEWEST LAST. A mail thread is a transcript; reading it top to
 * bottom is how it makes sense, and the newest message — the one you came for
 * — ends up nearest your thumb at the bottom of the scroll.
 *
 * BODIES ARE PLAIN TEXT AND SELECTABLE. The edge function hands back text,
 * flattening HTML when a sender only supplied HTML, so there is no WebView and
 * no remote content: no tracking pixel fires because the app opened a message.
 * `selectable` is what lets somebody copy a tracking number or an address out
 * of a supplier's email without a "copy" button for every field.
 *
 * REPLYING OPENS GMAIL. The service account is `gmail.readonly` on purpose —
 * see `lib/gmail.ts`. The compose deep link needs no scope, and a reply sent
 * from Gmail lands in Sent where Devon expects to find it.
 */

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function attachmentIcon(mimeType: string): keyof typeof Ionicons.glyphMap {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.includes('pdf')) return 'document-text';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return 'file-tray-full';
  if (mimeType.includes('sheet') || mimeType.includes('excel') || mimeType.includes('csv')) {
    return 'grid';
  }
  return 'document';
}

export default function EmailThreadScreen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const { phase, role } = useRoleGate();

  const [thread, setThread] = useState<MailThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAttachment, setBusyAttachment] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!threadId) {
      setLoading(false);
      setError('No conversation was selected.');
      return;
    }
    setLoading(true);
    const result = await fetchThread(threadId);
    setLoading(false);
    if (!result.ok) {
      setError(result.message);
      setThread(null);
      return;
    }
    setError(null);
    setThread(result.thread);
  }, [threadId]);

  useEffect(() => {
    if (phase !== 'ready' || !role?.isAdmin) {
      setLoading(false);
      return;
    }
    void load();
  }, [phase, role?.isAdmin, load]);

  const download = useCallback(
    async (message: MailMessage, attachment: MailAttachment) => {
      setBusyAttachment(attachment.attachmentId);
      setAttachmentError(null);
      const result = await saveAttachment({ messageId: message.id, attachment });
      setBusyAttachment(null);
      if (!result.ok) {
        setAttachmentError(result.message);
        return;
      }
      haptics.success();
    },
    [],
  );

  const title = thread?.subject ?? 'Email';
  const newest = thread?.messages[thread.messages.length - 1] ?? null;

  const screen = (body: React.ReactNode) => (
    <>
      <Stack.Screen options={{ title: 'Conversation' }} />
      {body}
    </>
  );

  if (phase === 'loading') {
    return screen(
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={colors.accentPrimary} />
      </View>,
    );
  }

  if (!role?.isAdmin) {
    return screen(
      <View style={[styles.screen, styles.padded]}>
        <View style={styles.card}>
          <View style={styles.badge}>
            <Ionicons name="lock-closed" size={26} color={colors.olive} />
          </View>
          <Text style={styles.cardTitle}>{role ? 'Admins only' : 'Sign in to read email'}</Text>
          <Text style={styles.cardBody}>
            Email is limited to signed-in owners and operators.
          </Text>
        </View>
      </View>,
    );
  }

  return screen(
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {loading ? (
        <SkeletonList count={3} height={140} gap={spacing.md} radius={radii.md} />
      ) : error ? (
        <EmptyState
          icon="cloud-offline"
          title="Could not open that conversation"
          body={error}
          action={{ label: 'Try again', onPress: () => void load() }}
        />
      ) : !thread || thread.messages.length === 0 ? (
        <EmptyState
          icon="mail-outline"
          title="Nothing to show"
          body="This conversation has no readable messages."
        />
      ) : (
        <>
          <Text style={styles.subject} selectable>
            {title}
          </Text>
          <Text style={styles.meta}>
            {thread.messages.length === 1
              ? '1 message · read-only'
              : `${thread.messages.length} messages · read-only`}
          </Text>

          <View style={styles.actionRow}>
            <ActionButton
              icon="arrow-undo"
              label="Reply in Gmail"
              onPress={() =>
                void openInGmail(
                  gmailReplyUrl(newest?.fromAddress ?? '', thread.subject ?? ''),
                )
              }
            />
            <ActionButton
              icon="open-outline"
              label="Open in Gmail"
              onPress={() => void openInGmail(gmailThreadUrl(thread.id))}
            />
          </View>

          {attachmentError ? (
            <View style={styles.errorCard}>
              <Ionicons name="alert-circle" size={16} color={colors.danger} />
              <Text style={styles.errorText}>{attachmentError}</Text>
            </View>
          ) : null}

          {thread.messages.map((message) => (
            <View key={message.id} style={styles.message}>
              <View style={styles.messageHeader}>
                <Text style={styles.from} numberOfLines={1} selectable>
                  {message.fromName || message.fromAddress || 'Unknown sender'}
                </Text>
                <Text style={styles.when}>{formatWhen(message.date)}</Text>
              </View>
              <Text style={styles.address} numberOfLines={1} selectable>
                {message.fromAddress}
              </Text>
              {message.to ? (
                <Text style={styles.address} numberOfLines={1} selectable>
                  To {message.to}
                </Text>
              ) : null}
              {message.cc ? (
                <Text style={styles.address} numberOfLines={1} selectable>
                  Cc {message.cc}
                </Text>
              ) : null}

              <Text style={styles.body} selectable>
                {message.bodyText.trim() || message.snippet || '(no message body)'}
              </Text>

              {message.attachments.length > 0 ? (
                <View style={styles.attachments}>
                  {message.attachments.map((attachment) => {
                    const busy = busyAttachment === attachment.attachmentId;
                    return (
                      <Pressable
                        key={attachment.attachmentId}
                        onPress={() => void download(message, attachment)}
                        disabled={busy}
                        style={({ pressed }) => [
                          styles.attachment,
                          pressed && !busy && styles.pressed,
                        ]}>
                        <View style={styles.attachmentIcon}>
                          {busy ? (
                            <ActivityIndicator color={colors.olive} size="small" />
                          ) : (
                            <Ionicons
                              name={attachmentIcon(attachment.mimeType)}
                              size={15}
                              color={colors.olive}
                            />
                          )}
                        </View>
                        <View style={styles.attachmentBody}>
                          <Text style={styles.attachmentName} numberOfLines={1}>
                            {attachment.filename}
                          </Text>
                          <Text style={styles.attachmentSize}>
                            {formatSize(attachment.size)}
                          </Text>
                        </View>
                        <Ionicons name="download-outline" size={16} color={colors.ocean} />
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
            </View>
          ))}

          <Text style={styles.footNote}>
            Read-only. Replies, archiving and deleting all happen in Gmail.
          </Text>
        </>
      )}
    </ScrollView>,
  );
}

function ActionButton({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={() => {
        haptics.tapMedium();
        onPress();
      }}
      accessibilityRole="button"
      style={({ pressed }) => [styles.action, pressed && styles.pressed]}>
      <Ionicons name={icon} size={15} color={colors.olive} />
      <Text style={styles.actionText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceAlt },
  center: { alignItems: 'center', justifyContent: 'center' },
  padded: { padding: spacing.lg },
  content: { padding: spacing.md, gap: spacing.sm, paddingBottom: spacing.xxl },

  card: {
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    ...shadows.card,
  },
  badge: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  cardBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  subject: { color: colors.ink, fontSize: 19, fontWeight: '800' },
  meta: { color: colors.inkSoft, fontSize: 12, fontWeight: '700' },

  actionRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', marginTop: spacing.xs },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.white,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.tan,
  },
  actionText: { color: colors.olive, fontSize: 13, fontWeight: '800' },

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
    backgroundColor: colors.white,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: 2,
    ...shadows.subtle,
  },
  messageHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  from: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '800' },
  when: { color: colors.inkSoft, fontSize: 11, fontWeight: '700' },
  address: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },
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
    backgroundColor: colors.oliveSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachmentBody: { flex: 1 },
  attachmentName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  attachmentSize: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },

  footNote: {
    textAlign: 'center',
    marginTop: spacing.sm,
    color: colors.inkSoft,
    fontSize: 12,
    fontWeight: '600',
  },
  pressed: { opacity: 0.7 },
});
