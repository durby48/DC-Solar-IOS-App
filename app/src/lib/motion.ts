import { Easing, useReducedMotion } from 'react-native-reanimated';

/**
 * The app's motion vocabulary. Every animation in DC Solar KC pulls its
 * duration, easing and spring from here, so "how the app moves" is one file
 * rather than a hundred magic numbers.
 *
 * ────────────────────────────────────────────────────────────────────────
 * REDUCED MOTION IS NOT OPTIONAL
 * ────────────────────────────────────────────────────────────────────────
 * `useMotion()` is the SINGLE gate. Nothing else in the app should call
 * `useReducedMotion()` or `AccessibilityInfo.isReduceMotionEnabled()` — if
 * there are two gates there will eventually be two behaviours. A permanently
 * moving element is a real problem for people with vestibular disorders, and
 * a crew member on a roof does not need a card bouncing at them.
 *
 * Reanimated captures the OS setting once at startup and does not re-render
 * when it changes, which is fine: the person toggles it in Settings and comes
 * back to the app.
 *
 * ────────────────────────────────────────────────────────────────────────
 * REACT COMPILER RULES (app.json sets `experiments.reactCompiler: true`)
 * ────────────────────────────────────────────────────────────────────────
 * The compiler memoises component bodies aggressively. Reanimated's shared
 * values are mutable boxes it cannot see into, so four rules hold everywhere
 * in this codebase:
 *
 *   1. NEVER read or write `sharedValue.value` during render. Reads happen
 *      inside `useAnimatedStyle` / `useAnimatedProps` / `useAnimatedReaction`
 *      worklets; writes happen in effects, gesture handlers and callbacks.
 *      A render-time read is a side effect the compiler is free to cache.
 *   2. Animated styles come from `useAnimatedStyle`, never from an inline
 *      object built in render. Same reason.
 *   3. No `useRef(new Animated.Value(0))` — the RN `Animated` API's ref
 *      pattern is exactly what the compiler is allowed to hoist and reuse.
 *      New motion is Reanimated only. (`Ticker`, `PipelineHero` and
 *      `ConnectionBanner` were converted for this reason.)
 *   4. If a component genuinely cannot obey the above, put the string
 *      `'use no memo'` as the FIRST statement in its body to opt that one
 *      component out — and leave a comment saying why. Nothing in
 *      `components/ui` needs it today.
 */

/**
 * Durations in milliseconds. Named for what the movement is doing, not for
 * how long it takes, so they can be retuned without renaming call sites.
 */
export const DURATION = {
  /** Press feedback, chip toggles — must feel like the finger caused it. */
  instant: 90,
  /** Small state changes: an icon swapping, a badge appearing. */
  fast: 160,
  /** The default. Entrances, banners, sheets. */
  base: 240,
  /** Something big moving: a hero surface, a modal. */
  slow: 380,
  /** Count-ups and celebratory motion, where the point is to be watched. */
  lazy: 900,
} as const;

/**
 * Easing curves. `standard` is the workhorse — a fast-out/slow-in curve that
 * makes an entrance feel like it settled rather than stopped.
 */
export const EASE = {
  standard: Easing.bezier(0.2, 0, 0, 1),
  /** Decelerate: things arriving on screen. */
  out: Easing.out(Easing.cubic),
  /** Accelerate: things leaving. */
  in: Easing.in(Easing.cubic),
  /** Constant speed. Marquees and spinners only — never for UI entrances. */
  linear: Easing.linear,
} as const;

/**
 * Spring configs. Springs beat timings for anything a finger drives, because
 * the overshoot is what reads as "physical".
 */
export const SPRING = {
  /** Press scale. Stiff and barely bouncy: feedback, not a toy. */
  press: { damping: 20, stiffness: 340, mass: 0.6 },
  /** General-purpose settle for layout and focus changes. */
  gentle: { damping: 18, stiffness: 180, mass: 0.9 },
  /** Visible overshoot — tab focus bounce, celebratory pops. */
  bouncy: { damping: 11, stiffness: 220, mass: 0.8 },
} as const;

/** Gap between consecutive items in a staggered entrance. */
export const STAGGER_MS = 45;

/**
 * Stagger stops accumulating after this many items. A 30-row list would
 * otherwise take 1.4 seconds to finish appearing, and the person is looking
 * at the top of it anyway.
 */
export const STAGGER_CAP = 8;

/** Delay for the nth item in a staggered entrance, capped. */
export function staggerDelay(index: number): number {
  if (!Number.isFinite(index) || index <= 0) return 0;
  return Math.min(Math.floor(index), STAGGER_CAP) * STAGGER_MS;
}

export interface Motion {
  /** False when the OS asks for reduced motion. Gate every animation on it. */
  enabled: boolean;
  /** A duration, or 0 when motion is off — `withTiming` then snaps. */
  ms: (duration: number) => number;
  /** A stagger delay, or 0 when motion is off. */
  delay: (index: number) => number;
}

/**
 * The one reduced-motion hook.
 *
 * Prefer `ms()`/`delay()` over branching: passing a 0 duration to
 * `withTiming` lands the value instantly, so most components need no `if` at
 * all. Branch on `enabled` only when the animation should not exist —
 * confetti, a pulse ring, an infinite marquee.
 */
export function useMotion(): Motion {
  const reduced = useReducedMotion();
  const enabled = !reduced;
  return {
    enabled,
    ms: (duration: number) => (enabled ? duration : 0),
    delay: (index: number) => (enabled ? staggerDelay(index) : 0),
  };
}
