/**
 * invite-customer — email a DC Solar customer an invitation to the portal.
 *
 * Admin-only. Uses Supabase's admin invite, which creates the auth user and
 * sends the "set your password" email, stamping the CRM `customer_id` into the
 * new user's metadata. The `handle_new_auth_user` trigger reads that metadata
 * and links the account to the right customer record on creation.
 *
 * Linking at invite time is the whole point: a customer never types which
 * account they are, so nobody can claim someone else's projects by signing up
 * with a guessed email.
 *
 * Requires the service role (creating users), hence an edge function; the
 * caller's admin role is re-checked here rather than trusted from the client.
 */

import { createClient } from 'jsr:@supabase/supabase-js@2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
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
    .select('id, name, email')
    .eq('id', body.customerId)
    .maybeSingle();
  if (custErr || !customer) return json({ error: 'Customer not found' }, 404);

  const row = customer as { id: string; name: string | null; email: string | null };
  const target = row.email?.trim();
  if (!target) {
    return json(
      { error: `${row.name ?? 'That customer'} has no email address on file. Add one first.` },
      400,
    );
  }

  // Already has a login? Say so instead of sending a confusing second invite.
  const { data: existing } = await admin
    .from('customer_accounts')
    .select('user_id, status')
    .eq('customer_id', row.id)
    .maybeSingle();
  if (existing) {
    return json({ ok: true, alreadyInvited: true, email: target });
  }

  const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(target, {
    data: { customer_id: row.id, full_name: row.name ?? '' },
    redirectTo: body.redirectTo ?? 'https://app.dcsolarkc.com/set-password',
  });
  if (inviteErr) return json({ error: inviteErr.message }, 502);

  return json({ ok: true, alreadyInvited: false, email: target });
});
