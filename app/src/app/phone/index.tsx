import { Redirect } from 'expo-router';

/**
 * `/phone` itself → the keypad.
 *
 * `initialRouteName` on the Tabs only decides which tab opens when the
 * navigator mounts client-side; a hard load of `/phone` (a refresh on
 * app.dcsolarkc.com, a pasted link) has no page to serve without this file
 * and 404s. The route is hidden from the tab bar in `_layout.tsx`
 * (`href: null`), so it is a doorway, not a fifth tab.
 */
export default function PhoneIndex() {
  return <Redirect href={'/phone/keypad' as never} />;
}
