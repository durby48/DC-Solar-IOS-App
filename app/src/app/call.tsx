import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CustomerAvatar } from '@/components/CustomerAvatar';
import { PulseRing } from '@/components/ui';
import { colors, fonts, radii, spacing } from '@/constants/theme';
import { fetchCallStatus, formatDuration, formatPhone, placeBridgeCall } from '@/lib/comms';
import { takeIncomingCall } from '@/lib/incomingCall';
import { playRingbackTone } from '@/lib/ringback';
import { inAppCallingSupported, startInAppCall, type ActiveCall, type CallState } from '@/lib/voice';

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

/**
 * How long we'll wait for real progress (the far end audibly ringing, or the
 * call ending one way or another) before giving up. A hung WebRTC/SDK
 * handshake never fires an event at all — no 'error', nothing — and without
 * this a person is left staring at "Calling…" forever with no way back to a
 * call that could actually go through (the bridge).
 */
const CALL_SETUP_TIMEOUT_MS = 30_000;

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
  // An answered incoming call is taken once, on first render, and then owns
  // this screen; everything below reads the same fields either way.
  const [incoming] = useState(() => (params.incoming === '1' ? takeIncomingCall() : null));
  const isIncoming = params.incoming === '1';
  const to = incoming ? incoming.phone : typeof params.to === 'string' ? params.to : '';
  const name = incoming
    ? incoming.name
    : typeof params.name === 'string' && params.name
      ? params.name
      : formatPhone(to);
  const customerId = incoming ? incoming.customerId : typeof params.customerId === 'string' ? params.customerId : null;
  const contactId = incoming ? incoming.contactId : typeof params.contactId === 'string' ? params.contactId : null;

  const [state, setState] = useState<CallState | 'starting'>('starting');
  const [detail, setDetail] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);
  const [speakerSupported, setSpeakerSupported] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [dialed, setDialed] = useState('');
  const [seconds, setSeconds] = useState(0);
  const [bridgeBusy, setBridgeBusy] = useState(false);
  const [bridgeNote, setBridgeNote] = useState<string | null>(null);

  const callRef = useRef<ActiveCall | null>(null);
  const startedAt = useRef<number | null>(null);
  const endedSeconds = useRef<number | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // An incoming call is already live when this screen appears: adopt it,
  // follow its state, never dial.
  useEffect(() => {
    if (!isIncoming) return;
    if (!incoming) {
      setState('ended');
      setDetail('That call has already ended.');
      return;
    }
    callRef.current = incoming.call;
    setSpeakerSupported(incoming.call.speakerSupported);
    startedAt.current = Date.now();
    setState(incoming.state);
    setDetail(incoming.detail);
    const unsubscribe = incoming.subscribe((next, info) => {
      if ((next === 'ended' || next === 'failed') && startedAt.current !== null) {
        endedSeconds.current = Math.round((Date.now() - startedAt.current) / 1000);
      }
      setState(next);
      setDetail(info ?? null);
    });
    return () => {
      unsubscribe();
      callRef.current?.hangUp();
    };
  }, [isIncoming, incoming]);

  // Place the call once, on mount. Strict-mode double mount is not a concern
  // in production; in dev the second Device simply replaces the first.
  useEffect(() => {
    if (isIncoming) return;
    if (!to) {
      setState('failed');
      setDetail('No number to dial.');
      return;
    }
    let cancelled = false;

    const clearWatchdog = () => {
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
    };

    watchdogRef.current = setTimeout(() => {
      if (cancelled) return;
      callRef.current?.hangUp();
      callRef.current = null;
      setState('failed');
      setDetail(
        'Taking too long to connect. Check your connection and try again, or ring their cell directly.',
      );
    }, CALL_SETUP_TIMEOUT_MS);

    void (async () => {
      const result = await startInAppCall({
        to,
        name,
        customerId,
        contactId,
        onState: (next, info) => {
          if (cancelled) return;
          if (next === 'active' && startedAt.current === null) startedAt.current = Date.now();
          if ((next === 'ended' || next === 'failed') && startedAt.current !== null) {
            endedSeconds.current = Math.round((Date.now() - startedAt.current) / 1000);
          }
          // The far end audibly ringing (or the call being over one way or
          // another) is real proof of life — that's the watchdog's job done.
          // 'connecting' alone is not: the SDK reports it immediately, before
          // anything has actually reached the other side.
          if (next === 'ringing' || next === 'active' || next === 'ended' || next === 'failed') {
            clearWatchdog();
          }
          setState(next);
          setDetail(info ?? null);
        },
      });
      if (cancelled) return;
      if (result.ok) {
        callRef.current = result.call;
        setSpeakerSupported(result.call.speakerSupported);
      } else {
        clearWatchdog();
        setState('failed');
        setDetail(result.message);
      }
    })();
    return () => {
      cancelled = true;
      clearWatchdog();
      callRef.current?.hangUp();
    };
  }, [to, name, customerId, contactId, isIncoming]);

  // Sound like a phone: a ringback tone while we're dialing or the far end
  // is ringing, so "Calling…" never sounds like the app has frozen. Web
  // only — on the phone Twilio plays the ringback into the call itself
  // (answerOnBridge=false, see twilio-voice-outbound).
  useEffect(() => {
    if (state !== 'connecting' && state !== 'ringing') return undefined;
    return playRingbackTone();
  }, [state]);

  // PHONE, OUTGOING: our leg is answered by Twilio before the other person
  // picks up (that is how the ringback gets to us), so the SDK cannot tell us
  // when they actually answer. The far leg's `answered` callback moves the
  // messages row to in-progress; poll it while ringing and promote to
  // 'active' then. A hang-up / no-answer still arrives through the SDK.
  useEffect(() => {
    if (Platform.OS === 'web' || isIncoming || state !== 'ringing') return undefined;
    let stopped = false;
    const tick = async () => {
      const sid = callRef.current?.sid;
      if (!sid) return;
      const status = await fetchCallStatus(sid);
      if (stopped) return;
      if (status === 'in-progress') {
        if (startedAt.current === null) startedAt.current = Date.now();
        setState('active');
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [state, isIncoming]);

  // Ended without ever connecting: say why, from the row's final status.
  useEffect(() => {
    if (Platform.OS === 'web' || isIncoming || state !== 'ended' || startedAt.current !== null) return undefined;
    let stopped = false;
    const sid = callRef.current?.sid;
    if (!sid) return undefined;
    // The far leg's completed callback can land a moment after our leg ends.
    const timer = setTimeout(() => {
      void fetchCallStatus(sid).then((status) => {
        if (stopped) return;
        if (status === 'no-answer') setDetail('No answer.');
        else if (status === 'busy') setDetail('Line busy.');
        else if (status === 'failed' || status === 'canceled') setDetail('The call could not be completed.');
      });
    }, 1500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [state, isIncoming]);

  // The timer.
  useEffect(() => {
    if (state !== 'active') return;
    const id = setInterval(() => {
      if (startedAt.current !== null) setSeconds(Math.round((Date.now() - startedAt.current) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [state]);

  const hangUp = () => {
    callRef.current?.hangUp();
    callRef.current = null;
    if (state !== 'ended' && state !== 'failed') {
      if (startedAt.current !== null) {
        endedSeconds.current = Math.round((Date.now() - startedAt.current) / 1000);
      }
      setState('ended');
    }
  };

  const leave = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/phone' as never);
  };

  const toggleMute = () => {
    const next = !muted;
    callRef.current?.mute(next);
    setMuted(next);
  };

  const toggleSpeaker = () => {
    const next = !speaker;
    setSpeaker(next);
    void callRef.current?.setSpeaker(next);
  };

  const pressKey = (key: string) => {
    callRef.current?.sendDigits(key);
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
              ? `Call ended${endedSeconds.current ? ` · ${formatDuration(endedSeconds.current)}` : ''}`
              : 'Call failed';

  const live = state === 'connecting' || state === 'ringing' || state === 'active';
  const over = state === 'ended' || state === 'failed';

  return (
    <>
      <Stack.Screen options={{ headerShown: false, gestureEnabled: false }} />
      <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
        <View style={styles.top}>
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
                onPress={() => setShowKeys((v) => !v)}
              />
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
  top: { alignItems: 'center', paddingTop: spacing.md },
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
