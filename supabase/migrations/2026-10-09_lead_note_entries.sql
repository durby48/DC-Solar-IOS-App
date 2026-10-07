-- Notes are ENTRIES, for leads too (2026-10-09, Carson: "notes are entries,
-- and they can be edited but they have a time stamp and date. Also have a
-- delete button").
--
-- Customers already had `customer_notes` rows. A lead had one free-text box
-- (`leads.notes`). Now a note row belongs to a customer OR a lead:
--   * customer_id becomes nullable, lead_id is added (cascade with the lead),
--     and one of the two must be set.
--   * Lead notes are visible to whoever can see the lead (the policy asks the
--     leads table itself, so its own RLS — own leads for a rep, all for a
--     sales manager / admin — decides) and NOT to crew: the company-member
--     read is narrowed to customer notes.
--   * Anyone may delete their OWN note (admins any) — before, only admins
--     could delete.
--   * Every lead's existing box text becomes its first entry, dated when the
--     lead was created, signed by the lead's rep (so they can still edit it,
--     as they could the box). `leads.notes` itself is left untouched as the
--     backup and for the old admin screens.
--   * A lead created WITH notes (Add prospect, an import) gets that text as
--     an entry automatically.
begin;

alter table public.customer_notes alter column customer_id drop not null;
alter table public.customer_notes
  add column if not exists lead_id uuid references public.leads(id) on delete cascade;
create index if not exists customer_notes_lead_idx on public.customer_notes (lead_id) where lead_id is not null;

alter table public.customer_notes drop constraint if exists customer_notes_owner_chk;
alter table public.customer_notes
  add constraint customer_notes_owner_chk check (customer_id is not null or lead_id is not null);

-- Crew read customer notes only (never a lead's).
drop policy if exists cn_member_select on public.customer_notes;
create policy cn_member_select on public.customer_notes
  for select using (public.is_company_member(company) and customer_id is not null);

-- A lead's notes: whoever can see the lead.
drop policy if exists cn_lead_select on public.customer_notes;
create policy cn_lead_select on public.customer_notes
  for select using (
    lead_id is not null
    and public.is_company_staff(company)
    and exists (select 1 from public.leads l where l.id = customer_notes.lead_id)
  );

drop policy if exists cn_lead_insert on public.customer_notes;
create policy cn_lead_insert on public.customer_notes
  for insert with check (
    lead_id is not null
    and public.is_company_staff(company)
    and author_email is not null
    and lower(author_email) = lower(public.jwt_email())
    and exists (select 1 from public.leads l where l.id = customer_notes.lead_id)
  );

-- Delete your own note (admins keep cn_admin_all for any note).
drop policy if exists cn_author_delete on public.customer_notes;
create policy cn_author_delete on public.customer_notes
  for delete using (
    public.is_company_staff(company)
    and lower(author_email) = lower(public.jwt_email())
  );

-- The box text → the first entry (once: skipped for a lead that has entries).
insert into public.customer_notes (company, lead_id, body, author_email, created_at, updated_at)
select l.company, l.id, trim(l.notes),
       lower(coalesce(nullif(trim(l.assigned_to), ''), nullif(trim(l.created_by), ''), 'imported')),
       l.created_at, l.created_at
  from public.leads l
 where nullif(trim(l.notes), '') is not null
   and not exists (select 1 from public.customer_notes n where n.lead_id = l.id);

-- A lead created with notes: those notes are its first entry.
create or replace function public.lead_notes_to_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(trim(new.notes), '') is not null then
    insert into public.customer_notes (company, lead_id, body, author_email)
    values (
      new.company, new.id, trim(new.notes),
      lower(coalesce(nullif(trim(auth.jwt() ->> 'email'), ''), nullif(trim(new.created_by), ''),
                     nullif(trim(new.assigned_to), ''), 'imported'))
    );
  end if;
  return new;
end;
$$;

drop trigger if exists leads_notes_to_entry on public.leads;
create trigger leads_notes_to_entry
  after insert on public.leads
  for each row execute function public.lead_notes_to_entry();

commit;
