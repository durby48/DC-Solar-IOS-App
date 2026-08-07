# Break-glass recovery

Procedures for when someone is locked out. All of these need the Supabase
**personal access token** (`~/Desktop/DC Solar LLC/secrets/supabase-access-token.txt`)
and run through the Management API — no dashboard clicking required, so they
work from a phone over SSH if it comes to that.

---

## 1. Locked out of two-factor authentication

**Symptom:** an owner/operator/crew member has 2FA enrolled and has lost the
authenticator app (new phone, wiped device, deleted entry). They can enter
their password but can't produce a code, so they can't reach the app to
disable it themselves.

**Fix:** delete their enrolled factor with the service role. Their next sign-in
is password-only, and they can re-enrol from More → Security.

```bash
TOKEN=$(grep -E '^SUPABASE_ACCESS_TOKEN' "$HOME/Desktop/DC Solar LLC/secrets/supabase-access-token.txt" | sed -E 's/.*= *//')
EMAIL="person@example.com"      # <-- the locked-out account

# See what they have enrolled first.
curl -s -X POST "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"select f.id, f.friendly_name, f.status, f.created_at from auth.mfa_factors f join auth.users u on u.id=f.user_id where lower(u.email)=lower('$EMAIL')\"}"

# Remove every factor on that account.
curl -s -X POST "https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/database/query" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"query\":\"delete from auth.mfa_factors where user_id = (select id from auth.users where lower(email)=lower('$EMAIL')) returning id\"}"
```

Deleting the factor rows also invalidates any `aal2` sessions built on them.
Tell the person to re-enrol immediately — an admin account with 2FA switched
off is exactly the thing 2FA was protecting against.

**Verified working 2026-08-06** before enrolment was offered to anyone, which
was the point: never ship a lock you don't already hold the key to.

---

## 2. Locked out of the account entirely (forgot password)

Send a recovery email from the dashboard (Authentication → Users → … → Send
recovery), or set `must_change_password` and hand them a temporary one, which
is the flow `set-password.tsx` already supports.

---

## 3. Someone deleted their own account by mistake

`delete-account` is permanent — the auth user is gone. For **staff**, their
`employees` row survives on purpose, so recreate the login with the same email
in the dashboard and they'll be recognised as staff again on first sign-in.
For **customers**, re-invite them from More → Customers; the invite relinks
them to the same CRM record.

---

## 4. Suspected credential compromise

1. Rotate keys: service role + publishable, Supabase PAT, both Google keys.
2. `update auth.users set banned_until = now() + interval '100 years'` for the
   affected account, or delete it.
3. Revoke sessions: `delete from auth.refresh_tokens where user_id = '<id>'`.
