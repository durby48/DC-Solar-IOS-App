import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { ResourceText } from '@/components/resources/ResourceText';
import { PulseRing } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import {
  adoptIncomingCall,
  dismissCallSession,
  getCallSession,
  hangUpCall,
  isLive,
  muteCall,
  sendCallDigits,
  setCallSpeaker,
  startCall,
  useCallSession,
  type SessionState,
} from '@/lib/callSession';
import { formatDuration, formatPhone, placeBridgeCall } from '@/lib/comms';
import { takeIncomingCall } from '@/lib/incomingCall';
import { fetchResources } from '@/lib/salesResources';
import { inAppCallingSupported } from '@/lib/voice';

/**
 * `/call` — the active-call screen, the way a phone shows one: who, how long,
 * Mute / Keypad / End.
 *
 * On the WEB the call is placed by the app itself (`lib/voice.web.ts`): the
 * Twilio Voice SDK, the DC Solar number as caller ID, audio through this
 * computer. On the PHONE, until Phase 4 ships the native SDK, this screen
 * cannot carry audio — so it offers the bridge instead (Twilio rings your
 * cell, then connects them) and says exactly that. Same screen, honest
 * about which one it is doing.
 *
 * If in-app calling is not set up yet (no API key / TwiML App on the edge
 * functions) the token call answers 503 and this screen shows the sentence
 * and the bridge button rather than a dead End button.
 */

const DTMF_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'] as const;

export default function CallScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    to?: string;
    name?: string;
    customerId?: string;
    contactId?: string;
    /** '1' when CallKit just answered an incoming call (lib/incomingCall.ts). */
    incoming?: string;
  }>();

  // THE CALL LIVES IN lib/callSession.ts (2026-10-09), so this screen can be
  // left mid-call and come back. On mount: adopt the call CallKit answered,
  // else come back to the live call, else place the one this screen was
  // opened for. (A strict-mode second run finds the call live and attaches.)
  const [sessionId] = useState<number | null>(() => {
    const existing = getCallSession();
    if (params.incoming === '1') {
      const incoming = takeIncomingCall();
      if (incoming) return adoptIncomingCall(incoming).id;
      return existing?.incoming ? existing.id : null;
    }
    if (isLive(existing)) return existing?.id ?? null;
    const dial = typeof params.to === 'string' ? params.to : '';
    // No number: the bottom-right button bringing back a call that just ended.
    if (!dial) return existing?.id ?? null;
    return startCall({
      to: dial,
      name: typeof params.name === 'string' && params.name ? params.name : formatPhone(dial),
      customerId: typeof params.customerId === 'string' ? params.customerId : null,
      contactId: typeof params.contactId === 'string' ? params.contactId : null,
    }).id;
  });
  const latest = useCallSession();
  const session = latest && latest.id === sessionId ? latest : null;

  const isIncoming = session?.incoming ?? params.incoming === '1';
  const to = session?.to ?? (typeof params.to === 'string' ? params.to : '');
  const name = session?.name ?? formatPhone(to);
  const customerId = session?.customerId ?? null;
  const contactId = session?.contactId ?? null;
  const state: SessionState = session?.state ?? 'ended';
  const detail = session ? session.detail : 'That call has already ended.';
  const muted = session?.muted ?? false;
  const speaker = session?.speaker ?? false;
  const speakerSupported = session?.speakerSupported ?? false;

  const [showKeys, setShowKeys] = useState(false);
  // The call script, on the call screen itself (2026-10-07): reading it never
  // leaves the call. Loaded the first time it is opened.
  const [showScript, setShowScript] = useState(false);
  const [script, setScript] = useState<string | null | undefined>(undefined);
  const toggleScript = () => {
    const next = !showScript;
    setShowScript(next);
    if (next) setShowKeys(false);
    if (next && script === undefined) {
      void fetchResources().then((items) => setScript(items.find((r) => r.kind === 'script')?.body ?? null));
    }
  };
  const [dialed, setDialed] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);

  // The timer.
  const startedAt = session?.startedAt ?? null;
  useEffect(() => {
    if (state !== 'active' || startedAt === null) return;
    const tick = () => setSeconds(Math.round((Date.now() - startedAt) / 1000));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [state, startedAt]);

  // Leaving the "Call ended" screen forgets the call (a live one carries on).
  useEffect(
    () => () => {
      if (sessionId !== null) dismissCallSession(sessionId);
    },
    [sessionId],
  );

  const hangUp = () => hangUpCall();

  const leave = () => {
    if (sessionId !== null) dismissCallSession(sessionId);
    if (router.canGoBack()) router.back();
    else router.replace('/phone' as never);
  };

  /** Keep talking, use the app; the green bottom-right button comes back here. */
  const minimize = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/' as never);
  };

  const toggleMute = () => muteCall(!muted);

  const toggleSpeaker = () => setCallSpeaker(!speaker);

  const pressKey = (key: string) => {
    sendCallDigits(key);
    setDialed((d) => (d + key).slice(-24));
  };

  /** The phone (pre-Phase-4) and any web failure: ring my cell first. */
  const bridge = async () => {
    setBridgeBusy(true);
    setBridgeNote('Ringing your cell…');
    const result = await placeBridgeCall({
      customerId: customerId ?? undefined,
      contactId: contactId ?? undefined,
      to: customerId || contactId ? undefined : to,
    });
    setBridgeBusy(false);
    setBridgeNote(result.ok ? 'Pick up your phone — we are dialling them next.' : result.message);
  };

  const endedSeconds = session?.endedSeconds ?? null;
  const statusLine =
    state === 'starting'
      ? inAppCallingSupported()
        ? 'Connecting…'
        : 'Starting…'
      : state === 'connecting'
        ? 'Calling…'
        : state === 'ringing'
          ? 'Ringing…'
          : state === 'active'
            ? formatDuration(seconds)
            : state === 'ended'
              ? `Call ended${endedSeconds ? ` · ${formatDuration(endedSeconds)}` : ''}`
              : 'Call failed';

  const live = state === 'connecting' || state === 'ringing' || state === 'active';
  const over = state === 'ended' || state === 'failed';

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.top}>
          {live ? (
            <Pressable
              onPress={minimize}
              accessibilityRole="button"
              accessibilityLabel="Leave the call screen; the call stays on"
              hitSlop={8}
              style={({ pressed }) => [styles.minimize, pressed && styles.pressed]}>
              <Ionicons name="chevron-down" size={18} color={colors.textOnDark} />
              <Text style={styles.minimizeText}>Use the app</Text>
            </Pressable>
          ) : null}
          <Text style={styles.from}>
            {isIncoming ? 'Incoming · DC Solar KC (816) 744-6473' : 'DC Solar KC · (816) 744-6473'}
          </Text>
        </View>

        <View style={styles.who}>
          <View style={styles.avatarWrap}>
            {state === 'connecting' || state === 'ringing' ? (
              <PulseRing color={colors.sun} radius={52} />
            ) : null}
            {/[A-Za-z]/.test(name) ? (
              <CustomerAvatar customer={{ id: customerId ?? contactId ?? to, name }} size={104} url={null} />
            ) : (
              // A bare number has no initials worth showing — "(8" is not a person.
              <View style={styles.numberAvatar}>
                <Ionicons name="person" size={48} color={colors.textOnDark} />
              </View>
            )}
          </View>
          <Text style={styles.name} numberOfLines={2}>
            {name}
          </Text>
          {name !== formatPhone(to) ? <Text style={styles.number}>{formatPhone(to)}</Text> : null}
          <View style={styles.statusRow}>
            {state === 'starting' || state === 'connecting' ? (
              <ActivityIndicator color={colors.textOnDark} size="small" />
            ) : null}
            <Text style={[styles.status, state === 'failed' && styles.statusFailed]}>{statusLine}</Text>
          </View>
          {detail && over ? <Text style={styles.detail}>{detail}</Text> : null}
          {showKeys && dialed ? <Text style={styles.dialed}>{dialed}</Text> : null}
        </View>

        {showScript && !over ? (
          <ScrollView style={styles.scriptPanel} contentContainerStyle={styles.scriptBody}>
            {script === undefined ? (
              <ActivityIndicator color={colors.textOnDark} />
            ) : (
              <ResourceText body={script} compact />
            )}
          </ScrollView>
        ) : null}

        {showKeys && live ? (
          <View style={styles.keys}>
            {DTMF_KEYS.map((key) => (
              <Pressable
                key={key}
                onPress={() => pressKey(key)}
                style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}>
                <Text style={styles.keyText}>{key}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {over ? (
          <View style={styles.overArea}>
            {/* Any in-app failure — not just "unsupported"/"not configured" —
                gets the same working way out: a call still needs to happen. */}
            {state === 'failed' ? (
              <>
                <Pressable
                  onPress={() => void bridge()}
                  disabled={bridgeBusy}
                  style={({ pressed }) => [styles.bridgeButton, (pressed || bridgeBusy) && styles.pressed]}>
                  {bridgeBusy ? (
                    <ActivityIndicator color={colors.textOnAction} size="small" />
                  ) : (
                    <>
                      <Ionicons name="call" size={16} color={colors.textOnAction} />
                      <Text style={styles.bridgeButtonText}>Ring my cell, then connect them</Text>
                    </>
                  )}
                </Pressable>
                {bridgeNote ? <Text style={styles.detail}>{bridgeNote}</Text> : null}
              </>
            ) : null}
            <Pressable onPress={leave} style={({ pressed }) => [styles.doneButton, pressed && styles.pressed]}>
              <Text style={styles.doneText}>Done</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.controls}>
            <View style={styles.controlRow}>
              <Control
                icon={muted ? 'mic-off' : 'mic'}
                label={muted ? 'Unmute' : 'Mute'}
                active={muted}
                disabled={!live}
                onPress={toggleMute}
              />
              <Control
                icon="keypad"
                label="Keypad"
                active={showKeys}
                disabled={!live}
                onPress={() => {
                  setShowKeys((v) => !v);
                  setShowScript(false);
                }}
              />
              <Control icon="document-text" label="Script" active={showScript} disabled={false} onPress={toggleScript} />
              {speakerSupported ? (
                <Control
                  icon={speaker ? 'volume-high' : 'volume-medium'}
                  label="Speaker"
                  active={speaker}
                  disabled={!live}
                  onPress={toggleSpeaker}
                />
              ) : null}
            </View>
            <Pressable
              onPress={hangUp}
              accessibilityLabel="End call"
              style={({ pressed }) => [styles.endButton, pressed && styles.pressed]}>
              <Ionicons name="call" size={30} color={colors.white} style={styles.endIcon} />
            </Pressable>
          </View>
        )}
      </SafeAreaView>
    </>
  );
}

function Control({
  icon,
  label,
  active,
  disabled,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.control, disabled && styles.controlDisabled, pressed && styles.pressed]}>
      <View style={[styles.controlCircle, active && styles.controlCircleActive]}>
        <Ionicons name={icon} size={26} color={active ? colors.textOnAction : colors.textOnDark} />
      </View>
      <Text style={styles.controlLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surfaceInverse, justifyContent: 'space-between' },
  top: { alignItems: 'center', paddingTop: spacing.md, gap: spacing.sm },
  minimize: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginLeft: spacing.md,
    backgroundColor: 'rgba(255,243,230,0.16)',
    borderRadius: radii.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  minimizeText: { color: colors.textOnDark, fontFamily: fonts.bold, fontSize: 13 },
  from: { color: colors.oliveDeep, fontFamily: fonts.medium, fontSize: 13, letterSpacing: 0.3 },
  who: { alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg },
  avatarWrap: { width: 104, height: 104, alignItems: 'center', justifyContent: 'center' },
  numberAvatar: {
    width: 104,
    height: 104,
    borderRadius: 52,
    backgroundColor: 'rgba(255,243,230,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: { color: colors.textOnDark, fontFamily: fonts.display, fontSize: 30, textAlign: 'center' },
  number: { color: colors.oliveDeep, fontFamily: fonts.medium, fontSize: 15 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.xs },
  status: { color: colors.textOnDark, fontFamily: fonts.semibold, fontSize: 18, fontVariant: ['tabular-nums'] },
  statusFailed: { color: colors.sun },
  detail: {
    color: colors.oliveDeep,
    fontFamily: fonts.medium,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
    paddingHorizontal: spacing.lg,
  },
  dialed: { color: colors.textOnDark, fontFamily: fonts.bold, fontSize: 20, letterSpacing: 2 },

  // The call script panel (2026-10-07).
  scriptPanel: { flex: 1, marginHorizontal: spacing.lg, marginBottom: spacing.md, borderRadius: radii.md, backgroundColor: colors.surface },
  scriptBody: { padding: spacing.md },
  keys: {
    width: 76 * 3 + spacing.md * 2,
    alignSelf: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: spacing.md,
  },
  key: {
    width: 76,
    height: 56,
    borderRadius: radii.md,
    backgroundColor: 'rgba(255,243,230,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: 'rgba(255,243,230,0.28)' },
  keyText: { color: colors.textOnDark, fontFamily: fonts.display, fontSize: 24 },

  controls: { alignItems: 'center', gap: spacing.lg, paddingBottom: spacing.xl },
  controlRow: { flexDirection: 'row', gap: spacing.xl },
  control: { alignItems: 'center', gap: spacing.xs },
  controlDisabled: { opacity: 0.4 },
  controlCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: 'rgba(255,243,230,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** An engaged control (mute, speaker) lights up tan, with the dark action glyph. */
  controlCircleActive: { backgroundColor: colors.sun },
  controlLabel: { color: colors.oliveDeep, fontFamily: fonts.medium, fontSize: 12 },
  endButton: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  endIcon: { transform: [{ rotate: '135deg' }] },

  overArea: { alignItems: 'center', gap: spacing.md, paddingBottom: spacing.xl, paddingHorizontal: spacing.lg },
  bridgeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.sun,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 4,
  },
  bridgeButtonText: { color: colors.textOnAction, fontFamily: fonts.bold, fontSize: 14 },
  doneButton: {
    backgroundColor: 'rgba(255,243,230,0.16)',
    borderRadius: radii.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm + 4,
  },
  doneText: { color: colors.textOnDark, fontFamily: fonts.bold, fontSize: 15 },
  pressed: { opacity: 0.7 },
});
