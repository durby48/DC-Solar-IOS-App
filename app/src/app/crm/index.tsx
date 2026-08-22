import { Redirect } from 'expo-router';

/**
 * `/crm` moved to the Customers tab (`/customers`) on 2026-08-22.
 *
 * The file stays as a redirect rather than being deleted, for the same reason
 * `/more/customers` still redirects here: the old path is in browser history
 * and bookmarks on app.dcsolarkc.com, it is in the More menu of every phone
 * still running an older bundle, and `crm/[id]`, `crm/inbox` and
 * `crm/settings` all still live under this directory. One hop beats a 404 for
 * the customer list.
 *
 * The screen itself never moved — it is `components/crm/CustomerList`, which
 * the tab renders directly.
 */
export default function CrmIndexRedirect() {
  return <Redirect href="/customers" />;
}
