/**
 * One bit of cross-screen state: "a signed-in-only screen has already thrown a
 * signed-out visitor at the login screen".
 *
 * Two screens fire it — `(tabs)/_layout.tsx` (the crew shell, 2026-08-22) and
 * `app/customer.tsx` (the portal, 2026-08-23). Both run the same gate: check
 * `getSession()` FIRST, bounce only when there is genuinely no session, and
 * bounce with `navigation.reset()` on the root stack rather than
 * `router.replace('/')`.
 *
 * WHY IT IS NOT A `useRef`
 *
 * The bounce UNMOUNTS the component that fires it — the gate resets the root
 * stack to `index`, which tears the whole screen down. Any guard living inside
 * that component dies with it, so it can never observe its own previous
 * bounce. It has to outlive the component, and the only thing that does is
 * module scope. (On web a full page load resets it, which is correct: a fresh
 * load is a fresh app session.)
 *
 * WHY IT IS IN ITS OWN FILE (2026-08-22)
 *
 * It used to be a `let` inside `(tabs)/_layout.tsx` that was only ever cleared
 * when a session existed. After the first bounce it stayed `true` forever, so
 * the SECOND signed-out visit to any tab route set the gate to `'out'`,
 * skipped the navigation, and left the spinner on screen with nothing coming
 * to replace it. The flag now has a second owner — the login screen clears it
 * on mount, which is the only proof that a bounce actually ARRIVED somewhere —
 * and two files cannot share a module-scope `let` in one of them.
 *
 * Nothing here is security. `employees` RLS decides what loads; this only
 * decides whether someone is looking at a spinner or a login form.
 */

let bounced = false;

/** A gate has just sent a signed-out visitor to the login screen. */
export function markBouncedToLogin(): void {
  bounced = true;
}

/**
 * The login screen mounted, so the bounce landed and the next one starts from
 * a clean slate. Called from `app/index.tsx`, not from the gate — the gate
 * cannot know whether its navigation actually resolved.
 */
export function clearBounceToLogin(): void {
  bounced = false;
}

/**
 * Has a bounce been fired that the login screen has not acknowledged yet?
 *
 * `true` here means the navigation was requested but `app/index.tsx` never
 * mounted — i.e. we are going round in a circle rather than making progress —
 * so the caller must not reach for a fallback navigation that could feed it.
 */
export function hasBouncedToLogin(): boolean {
  return bounced;
}
