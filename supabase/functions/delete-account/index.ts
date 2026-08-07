/**
 * delete-account — let a signed-in user permanently delete their own login.
 *
 * Apple requires this for any app that offers account creation (App Store
 * Review Guideline 5.1.1(v)), and it's the right thing to offer regardless.
 *
 * Deleting an auth user needs the service role, which must never reach the
 * client — hence an edge function. It deletes ONLY the caller's own account:
 * the id comes from the verified JWT, never from the request body, so there's
 * no id to tamper with.
 *
 * `customer_accounts.user_id` is `on delete cascade`, so the customer row goes
 * with the auth user.
 *
 * Deliberately NOT deleted: the `employees` roster row, if the caller is
 * staff. That's Devon's employment record, not the user's to remove — and the
 * jobs, hours and finance history that reference it must stay intact for the
 * business. Deleting the login revokes access, which is what the guideline is
 * about. The UI says so plainly.
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

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return json({ error: 'Missing Authorization header' }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const user = userData?.user;
  if (userErr || !user) return json({ error: 'Not signed in' }, 401);

  // Confirmation phrase must match, so a stray call can't wipe an account.
  let body: { confirm?: string };
  try {
    body = (await req.json()) as { confirm?: string };
  } catch {
    body = {};
  }
  if (body.confirm !== 'DELETE') {
    return json({ error: 'Confirmation missing.' }, 400);
  }

  const { error: delErr } = await admin.auth.admin.deleteUser(user.id);
  if (delErr) return json({ error: delErr.message }, 500);

  return json({ ok: true, deleted: user.email });
});
