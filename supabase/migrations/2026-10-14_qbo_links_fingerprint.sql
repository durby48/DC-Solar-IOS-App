-- qbo_links.fingerprint (2026-10-14): a hash of the app-side description of the
-- QuickBooks object (the import plan item). The sync compares it with the current
-- app data: same → nothing to do; different → update the QuickBooks object.
begin;
alter table public.qbo_links add column if not exists fingerprint text;
commit;
