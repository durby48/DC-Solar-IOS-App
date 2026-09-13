-- Permanently delete a customer — but only one with no business history.
--
-- Devon's rule (2026-09-13): a customer with jobs or money attached is NOT
-- deletable; the app offers Archive (hides it everywhere, keeps the books)
-- instead. Deleting such a row would silently null `jobs.customer_id` and
-- `finance_entries.customer_id` (both ON DELETE SET NULL), detaching reconciled
-- payments from the person who paid them.
--
-- `customers` has no DELETE policy and does not get one: this SECURITY
-- DEFINER function is the only way to delete, it re-checks
-- `is_company_admin`, and it refuses when ANY of these exist:
--   jobs, finance_entries, employee_hours   -- work and money history
--   customer_accounts                       -- a portal login tied to them
--   customer_documents                      -- files in storage (FK is NO ACTION,
--                                              and the files would be orphaned)
-- What goes with the customer: its notes and tasks (ON DELETE CASCADE).
-- What stays, unlinked: texts/calls (`messages`) and company contacts filed
-- under it (both ON DELETE SET NULL) — a contact is a person in its own right.
--
-- Refusals raise SQLSTATE 'P0001' with a message that starts "has_history:" so
-- the app can tell "archive instead" apart from a real failure.

begin;

create or replace function public.delete_customer(p_customer_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company text;
  v_name text;
  v_jobs int;
  v_money int;
  v_hours int;
  v_portal int;
  v_docs int;
begin
  select c.company, c.name into v_company, v_name
    from public.customers c
   where c.id = p_customer_id;

  if v_company is null then
    raise exception 'That customer no longer exists.' using errcode = 'P0002';
  end if;

  if not public.is_company_admin(v_company) then
    raise exception 'Only owners and operators can delete customers.' using errcode = '42501';
  end if;

  select count(*) into v_jobs from public.jobs where customer_id = p_customer_id;
  select count(*) into v_money from public.finance_entries where customer_id = p_customer_id;
  select count(*) into v_hours from public.employee_hours where customer_id = p_customer_id;
  select count(*) into v_portal from public.customer_accounts where customer_id = p_customer_id;
  select count(*) into v_docs from public.customer_documents where customer_id = p_customer_id;

  if v_jobs + v_money + v_hours + v_portal + v_docs > 0 then
    raise exception 'has_history:%', concat_ws(', ',
        case when v_jobs > 0 then v_jobs || case when v_jobs = 1 then ' job' else ' jobs' end end,
        case when v_money > 0 then v_money || case when v_money = 1 then ' payment or invoice' else ' payments and invoices' end end,
        case when v_hours > 0 then v_hours || ' logged hours' end,
        case when v_portal > 0 then 'a customer-portal login' end,
        case when v_docs > 0 then v_docs || case when v_docs = 1 then ' document' else ' documents' end end)
      using errcode = 'P0001';
  end if;

  delete from public.customers where id = p_customer_id;
  return v_name;
end;
$$;

revoke all on function public.delete_customer(uuid) from public, anon;
grant execute on function public.delete_customer(uuid) to authenticated;

commit;
