-- In-app calling (browser first), 2026-09-06: a Twilio client identity per
-- staff member.
--
-- WHY. The Twilio Voice SDK places a call as a "client" with an identity
-- string; Twilio then POSTs `From=client:<identity>` to the TwiML App's
-- webhook, which has to work out who that is to log the call under their
-- email. An email is not a legal Twilio identity (no @, no dots), so each
-- staff_profiles row gets a slug, derived once from the email and stored —
-- NOT re-derived ad hoc in two places, which is how the token minter and the
-- webhook drift apart.
--
-- Filled by trigger so the token function only has to upsert the row.
-- Idempotent: safe to re-run.

begin;

alter table public.staff_profiles
  add column if not exists voice_identity text;

create unique index if not exists staff_profiles_voice_identity_idx
  on public.staff_profiles (company, voice_identity)
  where voice_identity is not null;

comment on column public.staff_profiles.voice_identity is
  'Twilio Voice client identity for in-app calls: the email local part, '
  'lowercased, non-alphanumerics → _. Set by trigger; never typed by hand.';

create or replace function public.staff_profiles_voice_identity()
returns trigger
language plpgsql
as $$
begin
  if new.voice_identity is null or new.voice_identity = '' then
    new.voice_identity := regexp_replace(split_part(lower(new.email), '@', 1), '[^a-z0-9]', '_', 'g');
  end if;
  return new;
end;
$$;

drop trigger if exists staff_profiles_voice_identity_trg on public.staff_profiles;
create trigger staff_profiles_voice_identity_trg
  before insert or update on public.staff_profiles
  for each row execute function public.staff_profiles_voice_identity();

-- Existing rows.
update public.staff_profiles
   set voice_identity = regexp_replace(split_part(lower(email), '@', 1), '[^a-z0-9]', '_', 'g')
 where voice_identity is null;

commit;

-- Verify:
--   select email, voice_identity from public.staff_profiles;
