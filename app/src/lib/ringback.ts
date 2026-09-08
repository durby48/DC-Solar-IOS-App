import { Platform } from 'react-native';

/**
 * A synthetic ringback tone — the "brrrng… brrrng…" a real phone plays while
 * it waits for the other side to pick up (North American cadence: 440 Hz +
 * 480 Hz, 2 s on, 4 s off).
 *
 * WEB ONLY. Twilio's own telephony ringback normally rides the call's real
 * audio once the far leg starts ringing, but that depends on carrier/network
 * behavior the app cannot guarantee, and a silent "Calling…" reads as frozen.
 * This plays locally the instant dialing starts. On native, CallKit and the
 * Voice SDK already own the call's audio session (`voice.native.ts`); layering
 * a second local sound on top of that risks fighting AVAudioSession rather
 * than helping, so this is a no-op there.
 *
 * Call the returned function to stop — always call it (state change, unmount,
 * whichever comes first) or the oscillators run forever.
 */
export function playRingbackTone(): () => void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return () => {};

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return () => {};

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return () => {};
  }

  const gain = ctx.createGain();
  gain.gain.value = 0;
  gain.connect(ctx.destination);

  const oscillators = [440, 480].map((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start();
    return osc;
  });

  const RING_ON_MS = 2000;
  const RING_OFF_MS = 4000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;

  const cycle = (on: boolean) => {
    if (stopped) return;
    gain.gain.setValueAtTime(on ? 0.05 : 0, ctx.currentTime);
    timer = setTimeout(() => cycle(!on), on ? RING_ON_MS : RING_OFF_MS);
  };
  cycle(true);

  return () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    try {
      for (const osc of oscillators) osc.stop();
      void ctx.close();
    } catch {
      // already stopped/closed — nothing to clean up
    }
  };
}
