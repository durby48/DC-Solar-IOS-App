/**
 * invite-customer — email a DC Solar customer an invitation to the portal.
 *
 * Admin-only. Uses Supabase's admin invite, which creates the auth user and
 * sends the "set your password" email.
 *
 * THIS FUNCTION IS WHERE THE ACCOUNT GETS LINKED, AND IT IS THE ONLY PLACE
 * ENTITLED TO DO IT. (Changed 2026-08-22 — see
 * supabase/migrations/2026-08-22_review_fixes.sql, F1.)
 *
 * It used to stamp `customer_id` into the invited user's metadata and let the
 * `handle_new_auth_user` trigger copy it across. That trigger cannot tell an
 * admin invite from a self-signup: `raw_user_meta_data` is whatever the caller
 * sent, and `supabase.auth.signUp({ options: { data } })` with the public anon
 * key can send anything. Anyone who learned a customer UUID could sign up
 * pre-linked to that customer and read their invoices, balance and PDFs.
 *
 * So the trigger now files every new account UNLINKED and pending, and the
 * link is written here instead — with the service role, AFTER the caller has
 * been re-checked as an owner/operator. The metadata is still sent (full_name
 * is cosmetic and the customer_id is useful in the audit trail) but nothing
 * reads customer_id back out of it.
 *
 * Requires the service role (creating users), hence an edge function; the
 * caller's admin role is re-checked here rather than trusted from the client.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

const COMPANY = 'dc-solar';

// Browser callers (the web app) preflight with OPTIONS — answer it and
// echo CORS headers on every response, or the browser blocks the call.
// The CRM Invite button is pressed from app.dcsolarkc.com, so without this
// the preflight failed 405 and the invite never left the browser.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey);

  // --- caller must be a company admin -------------------------------------
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const email = userData?.user?.email?.toLowerCase();
  if (userErr || !email) return json({ error: 'Not signed in' }, 401);

  const { data: employee } = await admin
    .from('employees')
    .select('role')
    .eq('email', email)
    .maybeSingle();
  const role = (employee as { role?: string } | null)?.role;
  if (role !== 'owner' && role !== 'operator') return json({ error: 'Admins only' }, 403);

  // --- input ---------------------------------------------------------------
  let body: { customerId?: string; redirectTo?: string };
  try {
    body = (await req.json()) as { customerId?: string; redirectTo?: string };
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  if (!body.customerId) return json({ error: 'customerId is required' }, 400);

  const { data: customer, error: custErr } = await admin
    .from('customers')
    .select('id, name, email, company')
    .eq('id', body.customerId)
    .maybeSingle();
  if (custErr || !customer) return json({ error: 'Customer not found' }, 404);

  const row = customer as {
    id: string;
    name: string | null;
    email: string | null;
    company: string | null;
  };

  // Defensive: this function grants portal access to DC Solar's paperwork, and
  // the service role can see every company's rows. A customerId from another
  // tenant is not a 404 to hide behind — it is a bug or an attempt.
  if (row.company !== COMPANY) {
    return json({ error: 'That customer does not belong to DC Solar.' }, 400);
  }

  const target = row.email?.trim();
  if (!target) {
    return json(
      { error: `${row.name ?? 'That customer'} has no email address on file. Add one first.` },
      400,
    );
  }

  // Already has a login? Say so instead of sending a confusing second invite.
  // `.limit(1)` is load-bearing: customer_accounts.customer_id has no unique
  // constraint (crm_merge_customers relies on that), and two rows would make
  // `.maybeSingle()` answer PGRST116 → data: null → "no login yet" → a second
  // auth user for the same customer. Same shape of bug as the twilio lookups.
  const { data: existing } = await admin
    .from('customer_accounts')
    .select('user_id, status')
    .eq('customer_id', row.id)
    .limit(1)
    .maybeSingle();
  if (existing) {
    return json({ ok: true, alreadyInvited: true, email: target });
  }

  const { data: invited, error: inviteErr } = await admin.auth.admin.inviteUserByEmail(target, {
    data: { customer_id: row.id, full_name: row.name ?? '' },
    redirectTo: body.redirectTo ?? 'https://app.dcsolarkc.com/set-password',
  });
  if (inviteErr) return json({ error: inviteErr.message }, 502);

  const invitedUserId = invited?.user?.id;
  if (!invitedUserId) {
    // The email went out but we have no id to link. Say so rather than
    // reporting success on a half-done invite.
    return json(
      {
        error:
          'The invitation was sent but Supabase returned no user id, so the account could ' +
          'not be linked. Link it by hand on the customer record.',
      },
      502,
    );
  }

  // --- link the account ----------------------------------------------------
  // The auth.users insert has already fired handle_new_auth_user(), which
  // filed an UNLINKED, pending customer_accounts row (it deliberately ignores
  // the metadata above — see the header). Setting customer_id is what turns
  // that row into a portal login for this customer, and doing it here means it
  // only ever happens on the far side of the admin check at the top of this
  // function.
  const { data: triggerRow } = await admin
    .from('customer_accounts')
    .select('id, full_name')
    .eq('user_id', invitedUserId)
    .maybeSingle();
  const account = triggerRow as { id: string; full_name: string | null } | null;
  // coalesce(full_name, <customer name>): a name the account already carries is
  // what that person typed; the CRM name only fills a blank.
  const fullName = account?.full_name ?? row.name ?? null;

  const linkError = account
    ? (
        await admin
          .from('customer_accounts')
          .update({
            customer_id: row.id,
            status: 'invited',
            full_name: fullName,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', invitedUserId)
      ).error
    // Belt and braces: the trigger row should always exist by now, but an
    // invited user with no row would sign in to an empty portal forever.
    : (
        await admin.from('customer_accounts').insert({
          user_id: invitedUserId,
          email: target,
          full_name: fullName,
          customer_id: row.id,
          status: 'invited',
        })
      ).error;

  if (linkError) {
    return json(
      { error: `The invitation was sent but the account could not be linked: ${linkError.message}` },
      502,
    );
  }

  return json({ ok: true, alreadyInvited: false, email: target, linked: true });
});
