import { useLocalSearchParams } from 'expo-router';

import { LeadMapBody } from '@/components/map/LeadMapBody';

/**
 * `/lead-map` — Lead map (2026-10-07). Admins' Menu → CRM → Lead map, the
 * CRM list's map button, and (2026-10-09) the map in a lead's / customer's
 * panel, which opens it with `?focus=<record key>`: zoomed in on that pin,
 * on Satellite, every other pin still on the map. Sales reps also have it as
 * a tab (`(tabs)/map.tsx`). The body is components/map/LeadMapBody.tsx.
 */
export default function LeadMapScreen() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  return <LeadMapBody focusKey={typeof focus === 'string' && focus ? focus : null} />;
}
