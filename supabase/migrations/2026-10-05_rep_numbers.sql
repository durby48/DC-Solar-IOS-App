-- Each sales rep's own phone number: calls and texts from it, history on
-- their own records (2026-10-05, B3).
--
-- NUMBERS live in voice_routes (2026-09-08): one row per Twilio number, the
-- person it belongs to. The main number (+18167446473 → Devon, "Main office
-- number") is untouched. A rep's number:
--   • rings that rep for incoming calls (twilio-voice-inbound already routes
--     by the dialed number);
--   • is their caller ID and texting number (twilio-voice-outbound,
--     twilio-send-sms look the caller up here; everyone else keeps the
--     company number);
--   • sends incoming texts' push to that rep, not the admins (twilio-inbound).
-- Admins assign numbers to reps in the app (CRM settings → Phone numbers),
-- through the existing voice_routes admin policies.
--
-- WHAT A REP SEES. Texts and calls filed on THEIR records: a lead assigned to
-- them, or a customer that is theirs (is_sales_rep_for_customer). Never a
-- thread on someone else's record, a supplier contact, or an unfiled number.
-- They read the message templates and texting settings (the composer needs
-- them). They change nothing on a message except marking it read, and only
-- through mark_messages_read(), which re-checks the same visibility rule.
--
-- Idempotent: safe to re-run.

begin;

-- ---------------------------------------------------------------------------
-- 1. Rep 1's number — assigned to the TEST sales login until the real rep
--    has one (reassign in CRM settings → Phone numbers)
-- ---------------------------------------------------------------------------
insert into public.voice_routes (number_e164, company, assigned_to, label)
values ('+18165726192', 'dc-solar', 'test-sales@dcsolarkc.com', 'Sales rep 1')
on conflict (number_e164) do nothing;

-- ---------------------------------------------------------------------------
-- 2. A rep reads the messages on their own records
-- ---------------------------------------------------------------------------
drop policy if exists msg_sales_select on public.messages;
create policy msg_sales_select on public.messages
  for select using (
    public.is_company_sales(company)
    and (
      (lead_id is not null and exists (select 1 from public.leads l where l.id = messages.lead_id))
      or (customer_id is not null and public.is_sales_rep_for_customer(customer_id))
    )
  );

-- The composer's templates and the "is texting on" switch.
drop policy if exists cs_sales_select on public.comms_settings;
create policy cs_sales_select on public.comms_settings
  for select using (public.is_company_sales(company));

drop policy if exists mt_sales_select on public.message_templates;
create policy mt_sales_select on public.message_templates
  for select using (public.is_company_sales(company));

-- ---------------------------------------------------------------------------
-- 3. Mark a thread read (admins: any thread; reps: their own records only)
-- ---------------------------------------------------------------------------
-- Same two shapes as lib/comms.ts markThreadRead(): a customer's thread, or an
-- unfiled number's (customer_id null). A rep's number-shaped thread is a
-- prospect's — only rows filed on a lead assigned to them are touched.
create or replace function public.mark_messages_read(
  p_customer_id uuid default null,
  p_phone       text default null
)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_email   text := lower(public.jwt_email());
  v_company text := 'dc-solar';
  v_admin   boolean;
  v_sales   boolean;
  v_n       integer := 0;
begin
  if v_email is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  v_admin := public.is_company_admin(v_company);
  v_sales := public.is_company_sales(v_company);
  if not v_admin and not v_sales then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if p_customer_id is not null then
    if not v_admin and not public.is_sales_rep_for_customer(p_customer_id) then
      raise exception 'that customer is not yours' using errcode = '42501';
    end if;
    update public.messages
       set read_at = now(), read_by = v_email
     where company = v_company and direction = 'in' and read_at is null
       and customer_id = p_customer_id;
    get diagnostics v_n = row_count;
  elsif p_phone is not null then
    update public.messages m
       set read_at = now(), read_by = v_email
     where m.company = v_company and m.direction = 'in' and m.read_at is null
       and m.customer_id is null and m.from_number = p_phone
       and (
         v_admin
         or (m.lead_id is not null and exists (
               select 1 from public.leads l
                where l.id = m.lead_id and lower(coalesce(l.assigned_to, '')) = v_email))
       );
    get diagnostics v_n = row_count;
  end if;
  return v_n;
end;
$$;

revoke all on function public.mark_messages_read(uuid, text) from public, anon;
grant execute on function public.mark_messages_read(uuid, text) to authenticated;

commit;
