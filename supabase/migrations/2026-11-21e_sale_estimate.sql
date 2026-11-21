-- 2026-11-21 (Devon): "Sale estimate" — a soft valuation next to book value.
--   estimate = annualized SDE × company_settings.sale_multiple (default 3)
--   SDE      = QuickBooks net income + what the company paid Devon through Gusto
-- Gusto receipts list NET pay per person only, so the owner's gross for each run is
-- estimated as Devon's net × the run's gross ÷ the run's net (same withholding ratio
-- as the run as a whole). The 7/24 receipt is missing — that run stays null until it
-- arrives. Owner draws are NOT added back: they never reduced profit.
begin;

alter table public.company_settings add column if not exists sale_multiple numeric not null default 3
  check (sale_multiple > 0 and sale_multiple <= 10);
alter table public.payroll_runs add column if not exists owner_net numeric;
alter table public.payroll_runs add column if not exists owner_gross numeric;
comment on column public.payroll_runs.owner_net is 'Devon''s net pay on the Gusto receipt (2026-11-21).';
comment on column public.payroll_runs.owner_gross is 'Estimated owner gross = owner_net × gross_wages ÷ run net pay (receipt).';

update public.payroll_runs r
   set owner_net = v.owner_net,
       owner_gross = round(v.owner_net * r.gross_wages / v.run_net, 2)
  from (values
    ('27758e4f', 258.58, 1358.46),
    ('fc3c6415', 2276.72, 5808.37),
    ('65640bd2', 1215.73, 2849.79),
    ('7d114c83', 1737.20, 5093.93),
    ('baee358c', 0.00, 1246.75),
    ('fac77c1c', 1472.97, 7153.50),
    ('07f64415', 0.00, 6819.87),
    ('f3298472', 2243.42, 12579.67),
    ('64298d52', 565.64, 9842.99),
    ('11b6cf52', 2243.42, 10983.69),
    ('71dab78e', 2243.42, 5468.04)
  ) v(receipt, owner_net, run_net)
 where left(r.receipt_id, 8) = v.receipt and r.company = 'dc-solar';

commit;
