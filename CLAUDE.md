# DC Solar KC App

Start every session by reading HANDOFF.md (current state, accounts, conventions) and PLAN.md (roadmap). The Expo app lives in `app/` — see `app/AGENTS.md` for Expo SDK 57 docs guidance. Verify with `npx tsc --noEmit` + `npx expo export --platform web` (run inside `app/`) before any EAS build.

## Database changes

Migrations go in `supabase/migrations/`, and **you apply them yourself** — Devon no longer pastes them by hand (changed 2026-08-07). Use the Supabase Management API with the personal access token in `~/Desktop/DC Solar LLC/secrets/supabase-access-token.txt`, which documents the exact call:

```
POST https://api.supabase.com/v1/projects/kjamxfezsathrsbztiln/database/query
Authorization: Bearer <token>     body: {"query": "<sql>"}
```

The service-role key in `secrets/supabase-service-role-keys.txt` is for data reads/writes through `@supabase/supabase-js`; it cannot run DDL. Neither file lives in a git repo — never copy a key into one.

Still write the migration to `supabase/migrations/` before running it, so the schema keeps a history. Make them idempotent and wrap them in `begin` / `commit`.

**Verify RLS by simulating the user, not by reading the policy.** `finance_entries` once leaked every money row — $56,617 of payments plus pay rates — to four viewer accounts, and the policies looked reasonable. Postgres ORs permissive policies together, so one broad policy silently defeats every narrow one. Prove it instead:

```sql
begin;
set local role authenticated;
set local request.jwt.claims = '{"email":"someone@example.com","role":"authenticated"}';
select count(*) from public.finance_entries;
rollback;
```

Check both directions — that the right person gains access, *and* that everyone else still has none. Wrap any probe that writes in `begin` / `rollback`.
