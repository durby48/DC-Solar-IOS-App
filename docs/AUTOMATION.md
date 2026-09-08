# CRM automation (Phase 10, 2026-09-08)

Not a workflow engine. A short list of database events that call things
DC Solar already has. Every entry here says exactly what fires, what it
calls, how it cannot run twice, and what happens when it fails.

## 10A — what the audit found (hooks that already exist)

| Hook | Where | Notes |
|---|---|---|
| Database → push notification | `notify_webhook()` (pg_net → edge fn `notify`, shared secret) | Already used by `finance_entries`, `job_assignments`, `job_schedule_dates`. Async: never blocks the write. |
| Scheduled job | pg_cron 1.6.4 (`dropbox-sync-daily`, 07:30 UTC) + pg_net | The pattern for anything time-based (reminders, "idle for N days"). |
| Automatic lead event | `leads` INSERT with `source_ref` set (from `intake_lead`) | The one signal that a lead arrived without a person typing it. |
| Stage/status change | `job_stage_history` / `lead_status_history` triggers | Event source for future "moved to X" rules. |
| Tasks | plain rows in `tasks` (`lib/tasks.ts` for people) | A trigger can insert one; `created_by = 'automation'` marks it. |
| SMS | edge fn `twilio-send-sms` (needs an admin JWT; honours STOP) | Not callable from a trigger as-is; would need a service-role path. **Deferred.** |
| Email | edge fn `gmail-send` (needs a MAPPED user's JWT) | Sends only as the signed-in person's mailbox; there is no "system" sender. **Deferred by design.** |
| Push tokens | `push_tokens` (7 devices, 6 people) | Audience `admins` = owner/operator. |

Idempotency primitives available: `leads.source_ref` (unique), and now
`tasks.source_ref` (unique). Retries of the lead insert are already
`duplicate` at intake, so nothing downstream re-fires.

## What runs today

### 1. Automatic lead → follow-up task

- **Trigger:** `leads_automation_new_lead_trg`, AFTER INSERT on `leads`, only when `source_ref IS NOT NULL` (typed-in leads are untouched).
- **Action:** one row in `tasks`: `Contact new website lead · <name>`, notes with the phone/email, `lead_id` set, `assigned_to` = the lead's assignee (NULL today — website leads are unassigned by design), `created_by = 'automation'`, `source_ref = auto:new_lead:<lead_id>`.
- **Due:** 5:00 PM Central the day it arrives, or noon the next day when it arrives after 5 PM. One constant (`DUE_HOUR_LOCAL`) in `2026-09-08_automation_new_lead.sql`; the website promises 1–2 business days, so this is inside that. Devon can move it.
- **Idempotent:** unique partial index `tasks_source_ref_uq` + `ON CONFLICT DO NOTHING`.
- **Failure:** wrapped in an exception handler that `RAISE WARNING`s; the lead is already committed and stays.
- **Visible as:** `Task created automatically · Contact new website lead · <name>` · Automation, in the record's Activity; the task itself in the Tasks lens and the lead's detail panel like any other.

### 2. Automatic lead → admin push

- **Trigger:** `leads_notify_trg`, AFTER INSERT on `leads` WHEN `source_ref IS NOT NULL`, using the existing `notify_webhook()`.
- **Action:** `notify` (v22) pushes `🌐 New website lead — <name> · <phone|email>. A follow-up task is waiting in the CRM.` to admins' devices.
- **Idempotent:** one insert, one POST; the lead cannot be inserted twice.
- **Failure:** pg_net is async; a failed POST is a row in `net._http_response`, never an error on the insert.

## Tested (2026-09-08)

One anonymous website-style quote insert → one lead → **one** task (correct title, `created_by = automation`, `source_ref`, linked, unassigned, due next-day noon Central because it arrived after 5 PM) and **one** push (`net._http_response` 200 `{"sent":3}`, 73 ms after the insert). Retrying the same `source_ref` through `intake_lead` → `duplicate`, still one task. Replaying the task insert → `ON CONFLICT` no-op. Failure simulation (a `CHECK (false)` on `tasks` inside a rolled-back transaction) → the lead was created, zero tasks, no error. CRM Activity shows the automatic task with the Automation actor. Test lead, task and quote deleted afterwards.

## Deferred — needs a decision, not more code

| Candidate | Why it waits |
|---|---|
| Appointment reminder (text the customer the day before) | Customer-facing message: needs approved wording, timing, consent rule, sender; also needs a service-role SMS path (today's function requires an admin's JWT). pg_cron + `twilio-send-sms` is the shape. |
| Proposal / estimate idle for N days → task | Needs the N. Trivial to add as a pg_cron job writing `tasks` with `source_ref = auto:idle_estimate:<job_id>:<week>`. |
| Auto-assignment | No rule exists. Website leads stay unassigned. |
| Auto-text / auto-email a new lead | Not without explicit approval of content, trigger, timing and consent. Website consent is captured on the lead (`sms_opt_in_at`) when given, so the data is ready; the decision is not. |
