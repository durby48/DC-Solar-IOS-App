/**
 * The bottom tab bar's size (2026-10-09, Carson: "make the bottom nav bar fit
 * a little bit better"). It was a flat 62 pt INCLUDING the iPhone's home-bar
 * inset (34 pt), which left the icons and labels 28 pt to share. Now the bar
 * is 56 pt of content PLUS that inset. The keypad button reads the same
 * number to sit just above the bar (components/KeypadFab).
 */
export const TAB_BAR_CONTENT = 56;

export function tabBarHeight(bottomInset: number): number {
  return TAB_BAR_CONTENT + bottomInset;
}
