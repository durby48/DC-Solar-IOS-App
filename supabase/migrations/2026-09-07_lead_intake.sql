-- CRM Phase 9 (2026-09-07): automatic lead intake — website quote form → leads.
--
-- THE PROBLEM. dcsolarkc.com's quote form has been inserting into
-- `quote_requests` (this project) since July. Nothing reads that table but a
-- notification email. A quote request never became a lead, so the CRM never
-- saw it.
--
-- THE SHAPE. One SECURITY DEFINER function, `intake_lead(...)`, is the
-- canonical internal contract for every automatic source: it validates,
-- normalises, de-duplicates on `source_ref`, maps consent, writes the lead,
-- and reports what it did. The website feeds it through an AFTER INSERT
-- trigger on `quote_requests` — no marketing-site change, no second public
-- endpoint. A Google/Meta adapter later calls the same function.
--
-- SECURITY. `intake_lead` is executable by nobody but the owner (postgres)
-- and the trigger function, which is itself SECURITY DEFINER; anon and
-- authenticated cannot call either directly. Nothing the website submits can
-- set company, status, assigned_to, created_by, estimated_value, any
-- converted/lost field or an opt-out. `leads` RLS is untouched.
-- `quote_requests` keeps its insert-only public policy and no read policy.
--
-- THE TRIGGER NEVER BREAKS THE WEBSITE. Any error inside intake is caught,
-- written to `quote_requests.intake_outcome`, and the visitor's insert still
-- succeeds. A quote request that failed intake is visible, not lost.
--
-- DEDUPE (documented, deterministic):
--   * same (company, source_ref)            → `duplicate`: the existing lead is
--                                             returned, nothing is written.
--                                             Hard idempotency for retries and
--                                             replays.
--   * same phone_e164 / email as an OPEN     → `created`: a NEW lead is still
--     lead, a won/lost lead, or a customer     created — the same number is not
--                                             proof of the same submission
--                                             (spouses, a customer's next
--                                             project, a lost lead coming
--                                             back). The match is written into
--                                             the new lead's notes and, for an
--                                             open lead, a re-inquiry line onto
--                                             that lead too, so a rep sees both.
--
-- CONSENT is copied only when the source captured it (server-derived on the
-- website: sms_consent_at + source + disclosure version). `sms_opt_in_source`
-- carries "source@version" so the disclosure version survives without a
-- fourth column. Never inferred from a phone number being present.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Additive columns
-- ---------------------------------------------------------------------------
alter table public.leads
  add column if not exists source_ref        text,
  add column if not exists sms_opt_in_at     timestamptz,
  add column if not exists sms_opt_in_source text;

comment on column public.leads.source_ref is
  'Provenance + idempotency for automatic intake, e.g. website_quote:<quote_requests.id>. '
  'NULL for leads typed in by hand. Unique per company when set.';
comment on column public.leads.sms_opt_in_at is
  'When the person affirmatively opted in to SMS, copied from the source''s evidence. '
  'NULL = no recorded consent. Never inferred.';
comment on column public.leads.sms_opt_in_source is
  'Where consent was captured, as source@version, e.g. '
  'public_quote_form@dc_solar_sms_quote_v1_2026_08_25.';

create unique index if not exists leads_source_ref_uq
  on public.leads (company, source_ref) where source_ref is not null;

-- customers already has sms_opt_in_source; the timestamp is what conversion
-- needs to carry so the A2P record stays complete.
alter table public.customers
  add column if not exists sms_opt_in_at timestamptz;

alter table public.quote_requests
  add column if not exists lead_id        uuid references public.leads(id) on delete set null,
  add column if not exists intake_outcome text,
  add column if not exists intake_at      timestamptz;

comment on column public.quote_requests.lead_id is
  'The lead this request became (intake trigger). NULL = not intaken (see intake_outcome).';
comment on column public.quote_requests.intake_outcome is
  'created | duplicate | error: <reason> | skipped: <reason>. Written by the intake trigger or a replay.';

-- ---------------------------------------------------------------------------
-- 2. The canonical intake function
-- ---------------------------------------------------------------------------
create or replace function public.intake_lead(
  p_source              text,
  p_source_ref          text,
  p_name                text,
  p_phone               text,
  p_email               text,
  p_address             text,
  p_message             text        default null,
  p_service             text        default null,
  p_property_type       text        default null,
  p_insurance_claim     boolean     default null,
  p_submitted_at        timestamptz default now(),
  p_sms_consent_at      timestamptz default null,
  p_sms_consent_source  text        default null,
  p_sms_consent_version text        default null
)
returns table (lead_id uuid, outcome text, match_note text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_company   constant text := 'dc-solar';
  v_name      text;
  v_phone     text;
  v_email     text;
  v_e164      text;
  v_digits    text;
  v_existing  uuid;
  v_open      record;
  v_closed    record;
  v_customer  record;
  v_notes     text := '';
  v_match     text := null;
  v_source    text;
  v_when      text;
  v_id        uuid;
begin
  -- ---- validate + normalise (never trust the caller's whitespace) ----------
  v_name  := nullif(btrim(coalesce(p_name, '')), '');
  v_phone := nullif(btrim(coalesce(p_phone, '')), '');
  v_email := nullif(lower(btrim(coalesce(p_email, ''))), '');
  if v_name is null then
    -- The website requires a name; a source that omits it still gets a lead
    -- somebody can act on rather than a silent drop.
    v_name := coalesce(v_email, 'Unknown inquiry');
  end if;
  v_name := left(v_name, 200);
  if v_email is not null and v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    v_email := null;
  end if;
  v_digits := regexp_replace(coalesce(v_phone, ''), '[^0-9]', '', 'g');
  v_e164 := case
    when length(v_digits) = 10 then '+1' || v_digits
    when length(v_digits) = 11 and left(v_digits, 1) = '1' then '+' || v_digits
    else null
  end;
  v_source := case lower(coalesce(p_source, ''))
    when 'website' then 'Website'
    when '' then 'Website'
    else initcap(p_source)
  end;

  -- ---- Rule 1: hard idempotency on source_ref -----------------------------
  if p_source_ref is not null then
    select l.id into v_existing
      from public.leads l
     where l.company = v_company and l.source_ref = p_source_ref;
    if v_existing is not null then
      return query select v_existing, 'duplicate'::text, null::text;
      return;
    end if;
  end if;

  -- ---- Rule 2: same person? note it, never collapse it --------------------
  if v_e164 is not null or v_email is not null then
    select l.id, l.name, l.status into v_open
      from public.leads l
     where l.company = v_company
       and l.status not in ('won', 'lost')
       and ((v_e164 is not null and l.phone_e164 = v_e164)
         or (v_email is not null and lower(l.email) = v_email))
     order by l.created_at desc limit 1;
    if v_open.id is not null then
      v_match := format('Possible repeat: open lead "%s" (%s) has the same %s.',
                        v_open.name, v_open.id,
                        case when v_e164 is not null and exists (select 1 from public.leads x where x.id = v_open.id and x.phone_e164 = v_e164) then 'phone' else 'email' end);
      update public.leads
         set notes = concat_ws(E'\n', nullif(notes, ''),
               format('Re-inquiry via %s on %s (new lead %s).', v_source, to_char(p_submitted_at, 'Mon DD, YYYY'), '<pending>'))
       where id = v_open.id;
    else
      select l.id, l.name, l.status into v_closed
        from public.leads l
       where l.company = v_company
         and ((v_e164 is not null and l.phone_e164 = v_e164)
           or (v_email is not null and lower(l.email) = v_email))
       order by l.created_at desc limit 1;
      if v_closed.id is not null then
        v_match := format('Previous lead "%s" (%s, %s).', v_closed.name, v_closed.status, v_closed.id);
      end if;
    end if;
    select c.id, c.name into v_customer
      from public.customers c
     where c.company = v_company
       and c.archived_at is null
       and ((v_e164 is not null and c.phone_e164 = v_e164)
         or (v_email is not null and lower(c.email) = v_email))
     order by c.created_at desc limit 1;
    if v_customer.id is not null then
      v_match := concat_ws(' ', v_match, format('Existing customer "%s" (%s).', v_customer.name, v_customer.id));
    end if;
  end if;

  -- ---- notes: what the person told us, then the intake context ------------
  v_when := to_char(coalesce(p_submitted_at, now()), 'Mon DD, YYYY HH12:MI AM');
  v_notes := format('%s inquiry · %s', v_source, v_when);
  if p_service is not null and btrim(p_service) <> '' then
    v_notes := v_notes || E'\nService: ' || btrim(p_service);
  end if;
  if p_property_type is not null and btrim(p_property_type) <> '' then
    v_notes := v_notes || E'\nProperty: ' || btrim(p_property_type);
  end if;
  if p_insurance_claim then
    v_notes := v_notes || E'\nInsurance claim: yes';
  end if;
  if p_message is not null and btrim(p_message) <> '' then
    v_notes := v_notes || E'\nMessage: ' || left(btrim(p_message), 2000);
  end if;
  if v_match is not null then
    v_notes := v_notes || E'\n' || v_match;
  end if;

  -- ---- the lead ------------------------------------------------------------
  insert into public.leads (
    company, created_at, name, phone, email, address, source, source_ref, notes,
    status, created_by, sms_opt_in_at, sms_opt_in_source
  ) values (
    v_company,
    coalesce(p_submitted_at, now()),
    v_name, v_phone, v_email, nullif(btrim(coalesce(p_address, '')), ''),
    v_source, p_source_ref, v_notes,
    'new',
    lower(coalesce(p_source, 'website')),
    case when p_sms_consent_at is not null then p_sms_consent_at else null end,
    case when p_sms_consent_at is not null
         then concat_ws('@', coalesce(p_sms_consent_source, 'unknown'), p_sms_consent_version)
         else null end
  )
  returning id into v_id;

  -- Now that the new lead has an id, complete the cross-reference on the open lead.
  if v_open.id is not null then
    update public.leads
       set notes = replace(notes, '(new lead <pending>)', format('(new lead %s)', v_id))
     where id = v_open.id;
  end if;

  return query select v_id, 'created'::text, v_match;
end;
$$;

revoke all on function public.intake_lead(text, text, text, text, text, text, text, text, text, boolean, timestamptz, timestamptz, text, text)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. quote_requests → intake_lead, on insert
-- ---------------------------------------------------------------------------
create or replace function public.quote_requests_intake()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  begin
    select * into r from public.intake_lead(
      'website',
      'website_quote:' || new.id::text,
      new.name, new.phone, new.email, new.address,
      new.message, new.service_type, new.property_type, new.is_insurance_claim,
      new.created_at,
      case when new.sms_consent then new.sms_consent_at else null end,
      case when new.sms_consent then new.sms_consent_source else null end,
      case when new.sms_consent then new.sms_consent_version else null end
    );
    update public.quote_requests
       set lead_id = r.lead_id, intake_outcome = r.outcome, intake_at = now()
     where id = new.id;
  exception when others then
    -- The visitor's request must never fail because the CRM hiccupped.
    update public.quote_requests
       set intake_outcome = 'error: ' || left(sqlerrm, 200), intake_at = now()
     where id = new.id;
  end;
  return new;
end;
$$;

drop trigger if exists quote_requests_intake_trg on public.quote_requests;
create trigger quote_requests_intake_trg
  after insert on public.quote_requests
  for each row execute function public.quote_requests_intake();

commit;

-- No automatic replay here: historical rows are inspected and replayed (or
-- skipped, with the reason written to intake_outcome) by hand through the
-- same function. See docs/LEAD_INTAKE.md.
