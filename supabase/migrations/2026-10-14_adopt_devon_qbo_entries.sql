-- Devon added five bank-feed lines directly in QuickBooks after the import (2026-10-14).
-- His job choices become the app's, and his QuickBooks entries become the linked ones
-- (they hold the bank-feed match); the import's duplicates (317, 319, 320, 321) are
-- deleted from QuickBooks by the sync script run that follows.
begin;

update public.finance_entries f set
  job_id = v.job_id::uuid,
  extracted = f.extracted || jsonb_build_object('book_account', v.acct, 'book_account_by', 'devon-in-quickbooks',
    'reviewed_at', now(), 'reviewed_by', 'devonsd311@gmail.com'),
  description = coalesce(v.descr, f.description)
from (values
  ('1f40bbab-27c9-4795-a0db-2685aac0f30d', '60c9908f-fb00-4f34-8f27-fca419a61931', 'job_fuel', null),
  ('f3b5864c-dba2-414f-9e45-a12531d44ebc', 'e84a658f-835d-4c7f-aef0-3f9391497a8b', 'job_fuel', null),
  ('6910227e-9870-46a0-98aa-fa49f0ac1a0d', '24dde6df-0fb0-4001-b240-8017eccbee12', 'job_fuel', null),
  ('0ab856e7-3145-40aa-8579-1926accf38ee', '09375f97-7e03-4e1f-a8b5-217ad382839d', 'job_fuel', null),
  ('e885316c-c679-4b27-a70d-0f412fba88bb', 'e84a658f-835d-4c7f-aef0-3f9391497a8b', 'subcontractors', 'Check #8091 — contract labor, DC-26042 (SunSmart)')
) as v(id, job_id, acct, descr)
where f.id = v.id::uuid;

-- Point the links at Devon's QuickBooks entries (fingerprint cleared → the sync updates them).
update public.qbo_links l set
  app_key = v.ref, qbo_id = v.qbo_id, sync_token = null, fingerprint = null, synced_at = now()
from (values
  ('row:1f40bbab-27c9-4795-a0db-2685aac0f30d', '2026-10-13|-44.92|CASEYS #1093 BUCKNER MO', '354'),
  ('row:f3b5864c-dba2-414f-9e45-a12531d44ebc', '2026-10-13|-74.54|COSTCO GAS #1838 LEES SUMMIT MO', '353'),
  ('row:6910227e-9870-46a0-98aa-fa49f0ac1a0d', '2026-10-13|-55.31|COSTCO GAS #1838 LEES SUMMIT MO', '352'),
  ('row:0ab856e7-3145-40aa-8579-1926accf38ee', '2026-10-13|-97.20|QT 152 INDEPENDENCE MO', '351')
) as v(old_key, ref, qbo_id)
where l.company = 'dc-solar' and l.app_kind = 'purchase' and l.app_key = v.old_key;

insert into public.qbo_links (app_kind, app_key, qbo_type, qbo_id, app_ids)
values ('purchase', '2026-10-13|-1350.00|CHECK 8091', 'Purchase', '350', array['e885316c-c679-4b27-a70d-0f412fba88bb'::uuid])
on conflict (company, app_kind, app_key) do nothing;

commit;
