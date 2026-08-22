import { AppText, Screen } from '@/components/ui';
import { CustomerList } from '@/components/crm/CustomerList';

/**
 * The Customers tab.
 *
 * A shell around `components/crm/CustomerList`, which is the same screen
 * `/crm` used to serve — the CRM was written with this tab in mind, which is
 * why the list lives in `components/` rather than in a route file. `/crm` is
 * now a redirect here, so there is exactly one customer list at exactly one
 * URL.
 *
 * `scroll={false}`: the list is a `FlatList` and does its own scrolling.
 */
export default function CustomersTab() {
  return (
    <Screen scroll={false} padded={false} header={<AppText variant="title">Customers</AppText>}>
      <CustomerList />
    </Screen>
  );
}
