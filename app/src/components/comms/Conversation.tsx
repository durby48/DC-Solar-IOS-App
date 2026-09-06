import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { colors, radii, shadows, spacing } from '@/constants/theme';
import {
  MMS_MAX_ATTACHMENTS,
  NOT_CONFIGURED_SMS,
  fetchThread,
  formatDuration,
  markThreadRead,
  renderTemplate,
  sendSms,
  uploadMmsAttachment,
  useCommsRealtime,
  type CommsMessage,
  type MessageTemplate,
  type TemplateVars,
} from '@/lib/comms';
import { formatShortDate } from '@/lib/dates';

/**
 * One conversation, the way a phone shows one: bubbles newest at the bottom,
 * a composer anchored above the keyboard, pictures and saved texts.
 *
 * THERE IS EXACTLY ONE OF THESE, like the inbox. The Phone section's thread
 * screen (/messages/thread) and the customer record's Comms segment both
 * render it — the second one just wraps it in the customer's own header and
 * hands it the merge fields for the saved texts. Two chat renderers that
 * drift apart is the failure mode; prop-drilling is the price.
 *
 * WHO IS AT THE FAR END is a `target`: a customer, a lead, a supplier
 * (`contacts`), or a bare number for a stranger. The target decides which
 * `fetchThread` variant loads the history and what `sendSms` is told, and
 * nothing else in here cares which it is.
 *
 * PICTURES are compressed and uploaded the moment they are picked, so Send
 * only hands the server storage PATHS to sign. The client never sees a
 * MediaUrl. Twilio's cap is ten per message.
 *
 * Opening the thread is what marks it read — the moment a human actually
 * saw it, and the moment the badge should stop nagging.
 */

export interface ConversationTarget {
  customerId?: string | null;
  leadId?: string | null;
  contactId?: string | null;
  /** E.164 of the far end. Required for a stranger; used for read-stamping otherwise. */
  phone?: string | null;
}

/** "9:04 AM" today, "Tue 9:04 AM" this week, "12 Aug 9:04 AM" before that. */
function messageTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const clock = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return clock;
  const withinWeek = now.getTime() - date.getTime() < 6 * 24 * 3600 * 1000;
  if (withinWeek) {
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${clock}`;
  }
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}`;
}

/** "devonsd311@gmail.com" → "Devonsd311". Good enough to attribute a call. */
function authorName(email: string): string {
  const local = (email ?? '').split('@')[0] ?? '';
  const first = local.split(/[._-]/)[0] ?? local;
  if (!first) return 'Someone';
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export function Conversation({
  target,
  name,
  smsReady,
  optedOut = false,
  optedOutAt = null,
  jobId,
  templates = [],
  templateVars,
  banner,
  keyboardOffset = 92,
  autoFocus = false,
}: {
  target: ConversationTarget;
  /** What the composer placeholder calls them. */
  name: string;
  /** `comms_settings.sms_enabled`. False shows one honest sentence, no box. */
  smsReady: boolean;
  /** They replied STOP. Calling still works; texting is not offered. */
  optedOut?: boolean;
  optedOutAt?: string | null;
  jobId?: string | null;
  /** Saved texts. Omit and the Templates chip does not appear. */
  templates?: MessageTemplate[];
  templateVars?: TemplateVars;
  /** Rendered between the header and the messages — the stranger notice, say. */
  banner?: ReactNode;
  /** iOS: height of whatever native header sits above this. */
  keyboardOffset?: number;
  autoFocus?: boolean;
}) {
  const [messages, setMessages] = useState<CommsMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [composer, setComposer] = useState('');
  const [attachments, setAttachments] = useState<{ path: string; uri: string }[]>([]);
  const [attaching, setAttaching] = useState(false);
  const [sending, setSending] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const listRef = useRef<FlatList<CommsMessage>>(null);

  const customerId = target.customerId ?? null;
  const contactId = target.contactId ?? null;
  const leadId = target.leadId ?? null;
  const phone = target.phone ?? null;

  const load = useCallback(async () => {
    const rows = customerId
      ? await fetchThread(customerId)
      : contactId
        ? await fetchThread(contactId, { byContact: true })
        : phone
          ? await fetchThread(phone, { byPhone: true })
          : [];
    setMessages(rows);
    setLoading(false);
    if (customerId) void markThreadRead(customerId);
    else if (phone) void markThreadRead(null, phone);
  }, [customerId, contactId, phone]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Live updates for THIS thread. The focus refetch stays the source of
  // truth; this just means a reply appears while you are reading.
  useCommsRealtime(
    useCallback(() => {
      void load();
    }, [load]),
    customerId,
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const send = async () => {
    const body = composer.trim();
    if (!body && attachments.length === 0) return;
    setStatus(null);
    setSending(true);
    const result = await sendSms({
      customerId: customerId ?? undefined,
      leadId: leadId ?? undefined,
      contactId: contactId ?? undefined,
      to: customerId || leadId || contactId ? undefined : (phone ?? undefined),
      body,
      jobId: jobId ?? undefined,
      mediaPaths: attachments.map((a) => a.path),
    });
    setSending(false);
    if (result.ok) {
      setComposer('');
      setAttachments([]);
      await load();
    } else {
      setStatus(result.message);
    }
  };

  const pickAttachments = async () => {
    const room = MMS_MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setStatus(`A text can carry up to ${MMS_MAX_ATTACHMENTS} pictures.`);
      return;
    }
    setStatus(null);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        selectionLimit: room,
        quality: 0.8,
      });
      if (result.canceled || !result.assets?.length) return;
      setAttaching(true);
      let firstError: string | null = null;
      for (const asset of result.assets.slice(0, room)) {
        const upload = await uploadMmsAttachment({ uri: asset.uri, contentType: asset.mimeType });
        if (upload.ok) {
          setAttachments((prev) => [...prev, { path: upload.path, uri: asset.uri }]);
        } else if (!firstError) {
          firstError = upload.message;
        }
      }
      setAttaching(false);
      if (firstError) setStatus(firstError);
    } catch {
      setAttaching(false);
      setStatus('Could not attach that picture. Please try again.');
    }
  };

  /**
   * One message. Three shapes share this timeline on purpose: an outbound
   * text, an inbound text, and a call. Seeing "called them at 9:04, texted at
   * 9:12, they replied at 9:20" in one column is the entire point of putting
   * calls in the `messages` table rather than a log of their own.
   */
  const renderMessage = ({ item }: { item: CommsMessage }) => {
    if (item.channel === 'call') {
      const failed =
        item.status === 'failed' ||
        item.status === 'busy' ||
        item.status === 'no-answer' ||
        item.status === 'canceled';
      const who = item.sent_by ? authorName(item.sent_by) : null;
      return (
        <View style={styles.callPillWrap}>
          <Text style={styles.callPill}>
            {failed
              ? `Call failed · ${item.error ?? item.status}`
              : [
                  'Called',
                  item.duration_seconds ? formatDuration(item.duration_seconds) : item.status,
                  who,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Text>
        </View>
      );
    }

    const outbound = item.direction === 'out';
    const expanded = expandedId === item.id;
    const failed = item.status === 'failed' || item.status === 'undelivered';
    const deliveryLabel = outbound
      ? failed
        ? `${item.status === 'undelivered' ? 'Undelivered' : 'Failed'}${item.error ? ' — tap' : ''}`
        : item.status === 'delivered'
          ? 'Delivered'
          : item.status === 'sent'
            ? 'Sent'
            : 'Queued'
      : null;

    return (
      <Pressable
        onPress={() => setExpandedId(expanded ? null : item.id)}
        style={[styles.bubbleRow, outbound ? styles.bubbleRowOut : styles.bubbleRowIn]}>
        <View style={[styles.bubble, outbound ? styles.bubbleOut : styles.bubbleIn]}>
          {item.media_urls.map((url) => (
            <Image
              key={url}
              source={{ uri: url }}
              style={styles.bubbleImage}
              contentFit="cover"
              transition={120}
            />
          ))}
          {item.body ? <Text style={styles.bubbleText}>{item.body}</Text> : null}
          <Text style={styles.bubbleMeta}>
            {messageTime(item.created_at)}
            {deliveryLabel ? ` · ${deliveryLabel}` : ''}
          </Text>
          {expanded && failed && item.error ? (
            <Text style={styles.bubbleError}>
              {item.error}
              {item.error_code ? ` (${item.error_code})` : ''}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  const templateSheet =
    showTemplates && templates.length > 0 ? (
      <View style={styles.templateSheet}>
        <View style={styles.templateSheetHead}>
          <Text style={styles.templateSheetTitle}>Saved texts</Text>
          <Pressable
            onPress={() => setShowTemplates(false)}
            hitSlop={8}
            style={({ pressed }) => pressed && styles.pressed}>
            <Ionicons name="close" size={18} color={colors.inkSoft} />
          </Pressable>
        </View>
        <ScrollView style={styles.templateSheetList} keyboardShouldPersistTaps="handled">
          {templates.map((template) => {
            const merged = templateVars ? renderTemplate(template.body, templateVars) : template.body;
            return (
              <Pressable
                key={template.id}
                // Fills the box; NEVER sends. Somebody has to read what is
                // about to go out under the company's name.
                onPress={() => {
                  setComposer(merged);
                  setShowTemplates(false);
                }}
                style={({ pressed }) => [styles.templateOption, pressed && styles.rowPressed]}>
                <Text style={styles.templateOptionTitle}>{template.title}</Text>
                <Text style={styles.templateOptionBody}>{merged}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Text style={styles.hint}>Tapping one fills the box — nothing sends until you press Send.</Text>
      </View>
    ) : null;

  // "Text Andrew", but "Text (817) 823-2944" for a stranger — a formatted
  // number split on its first space is just "(817)".
  const firstName = /[A-Za-z]/.test(name) ? (name.split(' ')[0] ?? name) : name;
  const canSend = !sending && !attaching && (composer.trim().length > 0 || attachments.length > 0);

  const composerArea = optedOut ? (
    <View style={styles.optOutBanner}>
      <Ionicons name="hand-left" size={16} color={colors.coralDeep} />
      <Text style={styles.optOutText}>
        They replied STOP{optedOutAt ? ` on ${formatShortDate(optedOutAt.slice(0, 10))}` : ''}. You
        can still call.
      </Text>
    </View>
  ) : !smsReady ? (
    <View style={styles.noticeCard}>
      <Ionicons name="construct" size={16} color={colors.slateDeep} />
      <Text style={styles.noticeText}>{NOT_CONFIGURED_SMS}</Text>
    </View>
  ) : (
    <View style={styles.composerWrap}>
      {attachments.length > 0 || attaching ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.attachStrip}>
          {attachments.map((attachment) => (
            <View key={attachment.path} style={styles.attachThumb}>
              <Image source={{ uri: attachment.uri }} style={styles.attachThumbImage} contentFit="cover" />
              <Pressable
                onPress={() =>
                  setAttachments((prev) => prev.filter((a) => a.path !== attachment.path))
                }
                hitSlop={6}
                accessibilityLabel="Remove picture"
                style={({ pressed }) => [styles.attachRemove, pressed && styles.pressed]}>
                <Ionicons name="close" size={12} color={colors.white} />
              </Pressable>
            </View>
          ))}
          {attaching ? (
            <View style={[styles.attachThumb, styles.attachThumbBusy]}>
              <ActivityIndicator color={colors.ocean} size="small" />
            </View>
          ) : null}
        </ScrollView>
      ) : null}
      <View style={styles.composer}>
        <Pressable
          onPress={() => void pickAttachments()}
          disabled={attaching || sending}
          accessibilityLabel="Attach a picture"
          style={({ pressed }) => [styles.attachButton, (pressed || attaching) && styles.pressed]}>
          <Ionicons name="image" size={16} color={colors.ocean} />
          {attachments.length > 0 ? <Text style={styles.attachCount}>{attachments.length}</Text> : null}
        </Pressable>
        {templates.length > 0 ? (
          <Pressable
            onPress={() => setShowTemplates((v) => !v)}
            accessibilityLabel="Saved texts"
            style={({ pressed }) => [styles.templateChip, pressed && styles.pressed]}>
            <Ionicons name="albums" size={14} color={colors.ocean} />
          </Pressable>
        ) : null}
        <TextInput
          value={composer}
          onChangeText={setComposer}
          placeholder={attachments.length > 0 ? 'Add a note (optional)' : `Text ${firstName}`}
          placeholderTextColor={colors.inkSoft}
          multiline
          autoFocus={autoFocus}
          style={styles.composerInput}
        />
        <Pressable
          onPress={() => void send()}
          disabled={!canSend}
          accessibilityLabel="Send"
          style={({ pressed }) => [styles.sendButton, (pressed || !canSend) && styles.pressed]}>
          {sending ? (
            <ActivityIndicator color={colors.ink} size="small" />
          ) : (
            <Ionicons name="send" size={16} color={colors.ink} />
          )}
        </Pressable>
      </View>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? keyboardOffset : 0}>
      {banner}
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.ocean} />
        </View>
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          // Oldest first, newest at the bottom, and the list is scrolled to
          // the end whenever its content changes (first load, a reply, a
          // send). NOT `inverted`: on react-native-web the inversion flips
          // each row without flipping the container, so every bubble rendered
          // upside down on app.dcsolarkc.com. Scrolling to the end is the
          // same result on every platform.
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={renderMessage}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.ocean} />
          }
          ListEmptyComponent={
            <View style={styles.emptyThread}>
              <Ionicons name="chatbubbles-outline" size={22} color={colors.inkSoft} />
              <Text style={styles.emptyText}>
                {smsReady
                  ? 'Nothing yet. Say hello.'
                  : 'No conversation yet — texting from the DC Solar number is switched off.'}
              </Text>
            </View>
          }
        />
      )}
      {status ? <Text style={styles.statusText}>{status}</Text> : null}
      {templateSheet}
      {composerArea}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { flex: 1 },
  listContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    flexGrow: 1,
    // Short threads sit at the bottom, where the newest message belongs.
    justifyContent: 'flex-end',
  },
  emptyThread: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xl },
  emptyText: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  statusText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: '700',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xs,
  },

  bubbleRow: { flexDirection: 'row' },
  bubbleRowIn: { justifyContent: 'flex-start' },
  bubbleRowOut: { justifyContent: 'flex-end' },
  bubble: { maxWidth: '82%', borderRadius: radii.md, padding: spacing.sm + 2, gap: 4 },
  bubbleIn: { backgroundColor: colors.white, ...shadows.card },
  bubbleOut: { backgroundColor: colors.skySoft },
  bubbleText: { color: colors.ink, fontSize: 15, fontWeight: '500', lineHeight: 21 },
  bubbleMeta: { color: colors.inkSoft, fontSize: 11, fontWeight: '600' },
  bubbleError: { color: colors.danger, fontSize: 12, fontWeight: '700' },
  bubbleImage: {
    width: 200,
    height: 150,
    borderRadius: radii.sm,
    backgroundColor: colors.slateSoft,
  },
  callPillWrap: { alignItems: 'center' },
  callPill: {
    backgroundColor: colors.slateSoft,
    color: colors.slateDeep,
    fontSize: 12,
    fontWeight: '700',
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs + 1,
    overflow: 'hidden',
  },

  composerWrap: {
    backgroundColor: colors.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.tan,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    padding: spacing.md,
    backgroundColor: colors.white,
  },
  composerInput: {
    flex: 1,
    maxHeight: 120,
    backgroundColor: colors.canvas,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 2,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
  },
  templateChip: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButton: {
    width: 40,
    height: 40,
    borderRadius: radii.pill,
    backgroundColor: colors.sun,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  attachThumb: {
    width: 64,
    height: 64,
    borderRadius: radii.sm,
    backgroundColor: colors.slateSoft,
    overflow: 'hidden',
  },
  attachThumbBusy: { alignItems: 'center', justifyContent: 'center' },
  attachThumbImage: { width: '100%', height: '100%' },
  attachRemove: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(61,53,46,0.75)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachButton: {
    width: 36,
    height: 36,
    borderRadius: radii.pill,
    backgroundColor: colors.skySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachCount: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: colors.ocean,
    color: colors.white,
    fontSize: 10,
    fontWeight: '800',
    textAlign: 'center',
    lineHeight: 16,
    paddingHorizontal: 3,
    overflow: 'hidden',
  },

  templateSheet: {
    maxHeight: 300,
    backgroundColor: colors.canvas,
    borderTopWidth: 1,
    borderTopColor: colors.line,
    padding: spacing.md,
    gap: spacing.xs,
  },
  templateSheetHead: { flexDirection: 'row', alignItems: 'center' },
  templateSheetTitle: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '800' },
  templateSheetList: { maxHeight: 210 },
  templateOption: {
    backgroundColor: colors.white,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: 2,
    marginBottom: spacing.xs,
  },
  templateOptionTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  templateOptionBody: { color: colors.inkSoft, fontSize: 12, fontWeight: '500', lineHeight: 17 },
  rowPressed: { backgroundColor: colors.skySoft },
  hint: { color: colors.inkSoft, fontSize: 12, fontWeight: '600' },

  optOutBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.coralSoft,
    padding: spacing.md,
  },
  optOutText: { flex: 1, color: colors.coralDeep, fontSize: 13, fontWeight: '700' },
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.slateSoft,
    padding: spacing.md,
  },
  noticeText: { flex: 1, color: colors.inkSoft, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.6 },
});
