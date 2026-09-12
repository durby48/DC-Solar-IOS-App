import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { takeCompose } from '@/components/email';
import { colors, hubColors, radii, spacing } from '@/constants/theme';
import {
  createDraft,
  deleteDraft,
  fetchDraft,
  firstInvalidAddress,
  isScopeMissing,
  sendDraft,
  updateDraft,
  type ComposeMode,
} from '@/lib/gmail';
import * as haptics from '@/lib/haptics';
import { useRoleGate } from '@/lib/role';

/**
 * `/inbox/compose` — write an email. New, reply, reply-all, forward, or an
 * existing draft from the Drafts folder.
 *
 * THE DRAFT LIVES IN GMAIL. A few seconds after you stop typing the message
 * is saved as a Gmail draft (created once, then updated by its draftId), so
 * a dropped connection or a closed tab loses nothing, and the same draft is
 * there in the Gmail app. Send hands that draft to Gmail (`drafts.send`), so
 * Gmail files it in Sent and in the thread; Discard deletes it from Drafts.
 * Nothing about the message ever touches our database.
 *
 * TEXT ONLY, AND IT SAYS SO. Attachments are not supported from the app
 * yet; the caption under the body says to add them in Gmail. A draft that
 * already carries files is opened read-carefully: saving it from here would
 * drop them, so autosave is off and Send sends it as it is.
 *
 * Params (all optional strings): mode, draftId, to, cc, bcc, subject,
 * threadId, inReplyTo, references, and `prefill` — a one-shot key for the
 * quoted body (see components/email/composeStash.ts).
 */

const AUTOSAVE_MS = 3000;

type Params = {
  mode?: string;
  draftId?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  prefill?: string;
};

interface Fields {
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  text: string;
}

function titleFor(mode: ComposeMode | 'draft'): string {
  switch (mode) {
    case 'reply':
    case 'replyAll':
      return 'Reply';
    case 'forward':
      return 'Forward';
    case 'draft':
      return 'Draft';
    default:
      return 'New email';
  }
}

export default function ComposeEmailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<Params>();
  const { phase, role } = useRoleGate();

  const mode: ComposeMode | 'draft' = params.draftId
    ? 'draft'
    : params.mode === 'reply' || params.mode === 'replyAll' || params.mode === 'forward'
      ? params.mode
      : 'new';

  const [fields, setFields] = useState<Fields>({
    to: params.to ?? '',
    cc: params.cc ?? '',
    bcc: params.bcc ?? '',
    subject: params.subject ?? '',
    text: '',
  });
  const [showCcBcc, setShowCcBcc] = useState(Boolean(params.cc || params.bcc));
  const [threading, setThreading] = useState({
    threadId: params.threadId ?? '',
    inReplyTo: params.inReplyTo ?? '',
    references: params.references ?? '',
  });

  const [draftId, setDraftId] = useState<string | null>(params.draftId ?? null);
  const [loadingDraft, setLoadingDraft] = useState(Boolean(params.draftId));
  const [draftHasFiles, setDraftHasFiles] = useState(false);
  const [mailbox, setMailbox] = useState<string | null>(null);

  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  // The latest values for the autosave timer and the unmount flush, which
  // must not close over a stale render.
  const latest = useRef({ fields, threading, draftId, dirty, draftHasFiles, saving: false });
  useEffect(() => {
    latest.current = { fields, threading, draftId, dirty, draftHasFiles, saving };
  });
  const bodyRef = useRef<TextInput>(null);

  // One-shot prefill: the quoted original, handed over out-of-band.
  useEffect(() => {
    const stashed = takeCompose(params.prefill);
    if (stashed?.text) {
      setFields((f) => ({ ...f, text: stashed.text ?? '' }));
    }
    // Only on mount — the stash is consumed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opening an existing draft: pull its fields from Gmail.
  useEffect(() => {
    if (!params.draftId) return;
    let cancelled = false;
    void fetchDraft(params.draftId).then((result) => {
      if (cancelled) return;
      setLoadingDraft(false);
      if (!result.ok) {
        setSendError(result.message);
        return;
      }
      const d = result.draft;
      setMailbox(result.mailbox);
      setFields({ to: d.to, cc: d.cc, bcc: d.bcc, subject: d.subject, text: d.text });
      setShowCcBcc(Boolean(d.cc || d.bcc));
      setThreading({ threadId: d.threadId ?? '', inReplyTo: d.inReplyTo, references: d.references });
      setDraftHasFiles(d.hasAttachments);
      setSavedAt(d.date ? new Date(d.date) : new Date());
    });
    return () => {
      cancelled = true;
    };
  }, [params.draftId]);

  const edit = (patch: Partial<Fields>) => {
    setFields((f) => ({ ...f, ...patch }));
    setDirty(true);
    setSendError(null);
    setVersion((v) => v + 1);
  };

  /** Create or update the Gmail draft from the latest fields. Returns the draftId or null. */
  const save = useCallback(async (): Promise<string | null> => {
    const snap = latest.current;
    if (snap.saving) return snap.draftId;
    if (snap.draftHasFiles) return snap.draftId; // saving would drop the files
    const f = snap.fields;
    const empty = !f.to.trim() && !f.cc.trim() && !f.bcc.trim() && !f.subject.trim() && !f.text.trim();
    if (empty && !snap.draftId) return null;
    const invalid = firstInvalidAddress([f.to, f.cc, f.bcc]);
    if (invalid) {
      // Do not save half-typed addresses; Gmail would refuse them anyway.
      // Body and subject still get saved by dropping the bad field for now.
      setSaveError(`"${invalid}" is not an email address — not saved yet.`);
      return snap.draftId;
    }
    setSaving(true);
    setSaveError(null);
    const input = {
      to: f.to,
      cc: f.cc,
      bcc: f.bcc,
      subject: f.subject,
      text: f.text,
      threadId: snap.threading.threadId || null,
      inReplyTo: snap.threading.inReplyTo || null,
      references: snap.threading.references || null,
    };
    const result = snap.draftId ? await updateDraft(snap.draftId, input) : await createDraft(input);
    setSaving(false);
    if (!result.ok) {
      setSaveError(result.message);
      return snap.draftId;
    }
    setDraftId(result.draftId);
    if (result.threadId && !snap.threading.threadId) {
      setThreading((t) => ({ ...t, threadId: result.threadId ?? '' }));
    }
    setDirty(false);
    setSavedAt(new Date());
    return result.draftId;
  }, []);

  // Autosave: a few seconds after the last edit.
  useEffect(() => {
    if (version === 0) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [version, save]);

  // Leaving with unsaved edits: one last save, fire and forget.
  useEffect(() => {
    return () => {
      if (latest.current.dirty) void save();
    };
  }, [save]);

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/inbox');
  };

  const send = async () => {
    if (sending) return;
    setSendError(null);
    const f = fields;
    if (!f.to.trim()) {
      setSendError('Add a To address.');
      return;
    }
    const invalid = firstInvalidAddress([f.to, f.cc, f.bcc]);
    if (invalid) {
      setSendError(`"${invalid}" is not an email address.`);
      return;
    }
    if (!f.subject.trim() && !f.text.trim()) {
      setSendError('Write a subject or a message.');
      return;
    }
    if (draftHasFiles && dirty) {
      setSendError('This draft has attachments the app cannot keep. Send it unchanged, or finish it in Gmail.');
      return;
    }
    setSending(true);
    haptics.tapMedium();
    // Make sure Gmail has the final text, then send THAT draft so Gmail files it.
    const id = dirty || !draftId ? await save() : draftId;
    if (!id) {
      setSending(false);
      setSendError(saveError ?? 'Could not save the draft before sending.');
      return;
    }
    const result = await sendDraft(id);
    setSending(false);
    if (!result.ok) {
      setSendError(result.message);
      haptics.error();
      return;
    }
    haptics.success();
    setDirty(false);
    latest.current.dirty = false;
    leave();
  };

  const discard = async () => {
    if (discarding) return;
    setDiscarding(true);
    if (draftId) {
      const result = await deleteDraft(draftId);
      if (!result.ok) {
        setDiscarding(false);
        setConfirmDiscard(false);
        setSendError(result.message);
        return;
      }
    }
    setDiscarding(false);
    setDirty(false);
    latest.current.dirty = false;
    haptics.tapLight();
    leave();
  };

  const screen = (body: React.ReactNode) => (
    <>
      <Stack.Screen options={{ title: titleFor(mode) }} />
      {body}
    </>
  );

  if (phase === 'loading' || loadingDraft) {
    return screen(
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color={hubColors.crm.fg} />
      </View>,
    );
  }

  if (!role?.isAdmin) {
    return screen(
      <View style={[styles.screen, styles.center]}>
        <Ionicons name="lock-closed" size={26} color={hubColors.crm.fg} />
        <Text style={styles.gateTitle}>{role ? 'Admins only' : 'Sign in to send email'}</Text>
        <Text style={styles.gateBody}>Email is limited to signed-in owners and operators.</Text>
      </View>,
    );
  }

  const status = saving
    ? 'Saving…'
    : saveError
      ? saveError
      : dirty
        ? 'Unsaved changes'
        : savedAt
          ? `Draft saved ${savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`
          : 'Saves to Gmail Drafts as you type';
  const scopeProblem = (saveError && isScopeMissing(saveError)) || (sendError && isScopeMissing(sendError));

  return screen(
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 88 : 0}>
      <View style={styles.bar}>
        {confirmDiscard ? (
          <>
            <Text style={styles.confirmText}>Discard this draft?</Text>
            <Pressable onPress={() => setConfirmDiscard(false)} style={styles.barGhost} accessibilityRole="button">
              <Text style={styles.barGhostText}>Keep</Text>
            </Pressable>
            <Pressable
              onPress={() => void discard()}
              disabled={discarding}
              style={({ pressed }) => [styles.barDanger, (pressed || discarding) && styles.pressed]}
              accessibilityRole="button">
              {discarding ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <Text style={styles.barDangerText}>Discard</Text>
              )}
            </Pressable>
          </>
        ) : (
          <>
            <Pressable
              onPress={() => setConfirmDiscard(true)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Discard draft"
              style={({ pressed }) => [styles.barIcon, pressed && styles.pressed]}>
              <Ionicons name="trash-outline" size={20} color={colors.inkSoft} />
            </Pressable>
            <Text style={[styles.status, saveError && !scopeProblem ? styles.statusError : null]} numberOfLines={1}>
              {status}
            </Text>
            <Pressable
              onPress={() => void send()}
              disabled={sending || (draftHasFiles && dirty)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.send, (pressed || sending) && styles.pressed]}>
              {sending ? (
                <ActivityIndicator color={colors.white} size="small" />
              ) : (
                <>
                  <Text style={styles.sendText}>Send</Text>
                  <Ionicons name="send" size={15} color={colors.white} />
                </>
              )}
            </Pressable>
          </>
        )}
      </View>

      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        {scopeProblem ? (
          <View style={styles.warn}>
            <Ionicons name="key-outline" size={16} color={colors.danger} />
            <Text style={styles.warnText}>{saveError ?? sendError}</Text>
          </View>
        ) : null}
        {draftHasFiles ? (
          <View style={styles.warn}>
            <Ionicons name="attach" size={16} color={colors.amberDeep} />
            <Text style={[styles.warnText, { color: colors.amberDeep }]}>
              This draft has attachments. The app cannot keep them if you edit it here — send it as it is, or finish it
              in Gmail.
            </Text>
          </View>
        ) : null}

        <Field label="To">
          <TextInput
            value={fields.to}
            onChangeText={(to) => edit({ to })}
            placeholder="name@example.com, another@example.com"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            autoFocus={mode === 'new' && !fields.to}
            style={styles.input}
          />
          {!showCcBcc ? (
            <Pressable onPress={() => setShowCcBcc(true)} hitSlop={8} accessibilityRole="button">
              <Text style={styles.ccToggle}>Cc Bcc</Text>
            </Pressable>
          ) : null}
        </Field>
        {showCcBcc ? (
          <>
            <Field label="Cc">
              <TextInput
                value={fields.cc}
                onChangeText={(cc) => edit({ cc })}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.input}
              />
            </Field>
            <Field label="Bcc">
              <TextInput
                value={fields.bcc}
                onChangeText={(bcc) => edit({ bcc })}
                placeholderTextColor={colors.textMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                style={styles.input}
              />
            </Field>
          </>
        ) : null}
        <Field label="Subject">
          <TextInput
            value={fields.subject}
            onChangeText={(subject) => edit({ subject })}
            placeholder="Subject"
            placeholderTextColor={colors.textMuted}
            returnKeyType="next"
            onSubmitEditing={() => bodyRef.current?.focus()}
            style={styles.input}
          />
        </Field>

        <TextInput
          ref={bodyRef}
          value={fields.text}
          onChangeText={(text) => edit({ text })}
          placeholder="Write your message"
          placeholderTextColor={colors.textMuted}
          multiline
          autoFocus={mode !== 'new' && !params.draftId}
          textAlignVertical="top"
          style={styles.body}
        />

        {sendError && !scopeProblem ? (
          <View style={styles.warn}>
            <Ionicons name="alert-circle" size={16} color={colors.danger} />
            <Text style={styles.warnText}>{sendError}</Text>
          </View>
        ) : null}

        <Text style={styles.caption}>
          Sends as {mailbox ?? 'your dcsolarkc.com mailbox'} · plain text · attachments are not supported from the
          app yet — add them in Gmail.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>,
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.white },
  center: { alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
  gateTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  gateBody: { color: colors.inkSoft, fontSize: 14, fontWeight: '600', textAlign: 'center' },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    backgroundColor: colors.white,
  },
  barIcon: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radii.pill },
  status: { flex: 1, color: colors.textMuted, fontSize: 12, fontWeight: '600' },
  statusError: { color: colors.danger },
  send: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: hubColors.crm.fg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
    minWidth: 88,
    justifyContent: 'center',
  },
  sendText: { color: colors.white, fontSize: 14, fontWeight: '800' },
  confirmText: { flex: 1, color: colors.ink, fontSize: 14, fontWeight: '700' },
  barGhost: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  barGhostText: { color: colors.inkSoft, fontSize: 14, fontWeight: '800' },
  barDanger: {
    backgroundColor: colors.danger,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.md + 2,
    paddingVertical: spacing.sm + 2,
    minWidth: 88,
    alignItems: 'center',
  },
  barDangerText: { color: colors.white, fontSize: 14, fontWeight: '800' },

  form: { paddingBottom: spacing.xxl },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line,
    minHeight: 46,
  },
  fieldLabel: { width: 52, color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  input: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '600', paddingVertical: spacing.sm + 2 },
  ccToggle: { color: colors.textMuted, fontSize: 13, fontWeight: '700' },
  body: {
    minHeight: 260,
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 22,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  caption: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  warn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    backgroundColor: colors.dangerSoft,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  warnText: { flex: 1, color: colors.danger, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  pressed: { opacity: 0.6 },
});
