-- Migration 7: let admins edit and delete finance entries from the app
-- (fixing data-entry mistakes on estimates, invoices, payments, expenses).
-- Run in Supabase dashboard → SQL Editor. Re-runnable.

drop policy if exists fin_admin_update on public.finance_entries;
create policy fin_admin_update on public.finance_entries for update
  using (public.is_company_admin(company)) with check (public.is_company_admin(company));

drop policy if exists fin_admin_delete on public.finance_entries;
create policy fin_admin_delete on public.finance_entries for delete
  using (public.is_company_admin(company));
