-- Marketing art (2026-10-12): Gemini-drawn pictures for the sales call script
-- and the Solar Shield plans (Bronze / Silver / Gold) that customers see on the
-- brochure. Drawn by the `marketing-art` edge function (admin or service role),
-- which owns the prompts so a redraw stays on-brand.
--
-- marketing_art: one row per picture slot ('script-hero', 'shield-program',
--   'shield-bronze', 'shield-silver', 'shield-gold'); `path` is the current file
--   in the PUBLIC 'marketing-art' bucket. Each redraw writes a new file name, so
--   phones and the CDN never show a stale cached picture.
-- Read by anyone, including signed-out brochure visitors: these are adverts.
-- No client writes — only the edge function (service role) changes rows/files.
--
-- Idempotent.

begin;

create table if not exists public.marketing_art (
  key         text primary key,
  company     text not null default 'dc-solar',
  path        text not null,
  prompt      text,
  updated_at  timestamptz not null default now(),
  updated_by  text
);

alter table public.marketing_art enable row level security;
drop policy if exists ma_public_select on public.marketing_art;
create policy ma_public_select on public.marketing_art for select to anon, authenticated using (true);
grant select on public.marketing_art to anon, authenticated;

insert into storage.buckets (id, name, public) values ('marketing-art', 'marketing-art', true)
on conflict (id) do update set public = true;
-- Public bucket: objects are served by URL without a policy. No insert/update/
-- delete policies on purpose — only the service role writes here.

comment on table public.marketing_art is
  'Current Gemini-drawn marketing pictures (script hero, Solar Shield tiers). Written only by the marketing-art edge function.';

commit;
