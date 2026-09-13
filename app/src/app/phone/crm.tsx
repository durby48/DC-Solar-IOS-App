import { Redirect } from 'expo-router';

/**
 * `/phone/crm` — the CRM button in the phone section's bottom bar.
 *
 * The button itself never shows this screen: its `tabPress` listener in
 * `_layout.tsx` leaves the phone section and selects the app's CRM tab. This
 * file exists because every Tabs button needs a route, and so a direct load
 * of the path (a web refresh, a pasted link) goes to the same place.
 */
export default function PhoneCrmRedirect() {
  return <Redirect href={'/(tabs)/workspace' as never} />;
}
