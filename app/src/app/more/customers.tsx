import { Redirect } from 'expo-router';

/**
 * `/more/customers` moved to `/crm` on 2026-08-22, and `/crm` moved to the
 * Customers tab later the same day. This points straight at the destination
 * rather than chaining through the intermediate redirect.
 *
 * The file stays as a redirect rather than being deleted: the old path is in
 * the More menu on every phone still running an older bundle, it is in
 * browser history and bookmarks on app.dcsolarkc.com, and a 404 for the
 * customer list is a worse outcome than one hop.
 */
export default function LegacyCustomersRedirect() {
  return <Redirect href="/customers" />;
}
