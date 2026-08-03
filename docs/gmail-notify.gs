/**
 * DC Solar — Gmail → push-notification + transaction-log bridge (Google Apps Script).
 *
 * Runs on Devon's devon@dcsolarkc.com Google Workspace account. Every few
 * minutes it looks for mail labeled DC-Notify that hasn't been forwarded
 * yet, POSTs {from, subject, snippet, messageId, date, body} to the
 * Supabase `notify` edge function, and marks the thread DC-Notified so
 * it's never sent twice. The function pushes to the admins' phones AND —
 * when the email parses as a bank/GC transaction (deposit, payment,
 * purchase, withdrawal…) — inserts a finance_entries row so the app's
 * Financials/Pipeline numbers update automatically.
 *
 * WHAT COUNTS AS A TRIGGER is controlled entirely by Gmail filters — e.g.
 * Chase deposit alerts, GC payment-confirmation emails. New source =
 * new Gmail filter applying DC-Notify. No code changes.
 *
 * SETUP (one time, in script.google.com while signed in as devon@dcsolarkc.com):
 *   1. New project → paste this file over Code.gs.
 *   2. Project Settings → Script Properties → add:
 *        FUNCTION_URL  = https://kjamxfezsathrsbztiln.supabase.co/functions/v1/notify
 *        NOTIFY_SECRET = (the same secret set on the edge function)
 *   3. In Gmail, create labels DC-Notify and DC-Notified.
 *   4. Triggers (clock icon) → Add trigger → checkDcNotify → time-driven →
 *      minutes timer → every 5 minutes. Authorize when prompted.
 *   5. Test: apply DC-Notify to any email, run checkDcNotify manually once,
 *      and the push should arrive (device must be signed in to the app).
 *
 * BACKFILL (one time): run backfillDcNotify from the editor's Run menu.
 * It replays EVERY DC-Notify email since 2026-07-24 (including already-
 * notified ones) with backfill:true — the function logs the transactions
 * into finance_entries WITHOUT sending pushes, and skips anything already
 * logged (deduped by Gmail message id), so it's safe to run repeatedly.
 */

function postToNotify_(payload) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('FUNCTION_URL');
  var secret = props.getProperty('NOTIFY_SECRET');
  if (!url || !secret) {
    throw new Error('Set FUNCTION_URL and NOTIFY_SECRET in Script Properties.');
  }
  return UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-notify-secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
}

function messagePayload_(message) {
  return {
    from: message.getFrom(),
    subject: message.getSubject() || '(no subject)',
    snippet: (message.getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    // The fields below let the notify function parse transactions and dedupe:
    messageId: message.getId(),
    date: Utilities.formatDate(message.getDate(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'"),
    body: (message.getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 4000),
  };
}

/** Live poller — runs every 5 minutes from the time-driven trigger. */
function checkDcNotify() {
  var notified = GmailApp.getUserLabelByName('DC-Notified');
  if (!notified) notified = GmailApp.createLabel('DC-Notified');

  // Only threads labeled by the user's filters and not yet forwarded.
  var threads = GmailApp.search('label:DC-Notify -label:DC-Notified', 0, 20);

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var last = messages[messages.length - 1];

    var response = postToNotify_(messagePayload_(last));

    // Only mark done on success so failures retry on the next run.
    if (response.getResponseCode() === 200) {
      thread.addLabel(notified);
    } else {
      console.warn('notify failed: HTTP ' + response.getResponseCode() + ' — will retry');
    }
  }
}

/**
 * One-time backfill: log every DC-Notify transaction since 2026-07-24 into
 * finance_entries. No pushes are sent. Safe to re-run — the edge function
 * skips messages it has already logged. Check the execution log for a
 * per-email summary when it finishes.
 */
function backfillDcNotify() {
  var CUTOFF = new Date('2026-07-24T00:00:00Z');
  var threads = GmailApp.search('label:DC-Notify after:2026/07/24', 0, 500);
  var results = { logged: 0, duplicate: 0, 'not-a-transaction': 0, error: 0, failed: 0 };

  for (var i = 0; i < threads.length; i++) {
    var messages = threads[i].getMessages();
    for (var j = 0; j < messages.length; j++) {
      var message = messages[j];
      if (message.getDate() < CUTOFF) continue;

      var payload = messagePayload_(message);
      payload.backfill = true;
      var response = postToNotify_(payload);

      if (response.getResponseCode() === 200) {
        var body = JSON.parse(response.getContentText());
        var outcome = body.logged || 'not-a-transaction';
        results[outcome] = (results[outcome] || 0) + 1;
        console.log('[' + outcome + '] ' + payload.date + ' — ' + payload.subject);
      } else {
        results.failed++;
        console.warn('[FAILED HTTP ' + response.getResponseCode() + '] ' + payload.subject);
      }
    }
  }
  console.log('Backfill done: ' + JSON.stringify(results));
}
