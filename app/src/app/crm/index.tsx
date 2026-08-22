import { Stack } from 'expo-router';

import { CustomerList } from '@/components/crm/CustomerList';

/**
 * `/crm` — the customer list.
 *
 * A deliberately thin shell. The screen itself lives in
 * `components/crm/CustomerList.tsx` because it gets a second home in Phase 3:
 * the tab bar gains a Customers tab (`(tabs)/customers.tsx`) which renders the
 * same component. Until then this root-stack route gives it a header and a
 * back button, following the `more/*` convention of declaring the title in the
 * body rather than in `app/_layout.tsx`.
 */
export default function CrmIndexScreen() {
  return (
    <>
      <Stack.Screen options={{ title: 'Customers' }} />
      <CustomerList />
    </>
  );
}
