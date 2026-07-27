/**
 * DC Solar — Gmail → push-notification bridge (Google Apps Script).
 *
 * Runs on Devon's devon@dcsolarkc.com Google Workspace account. Every few
 * minutes it looks for mail labeled DC-Notify that hasn't been forwarded
 * yet, POSTs {from, subject, snippet} to the Supabase `notify` edge
 * function (which pushes to the admins' phones), and marks the thread
 * DC-Notified so it's never sent twice.
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
 */

function checkDcNotify() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('FUNCTION_URL');
  var secret = props.getProperty('NOTIFY_SECRET');
  if (!url || !secret) {
    throw new Error('Set FUNCTION_URL and NOTIFY_SECRET in Script Properties.');
  }

  var notified = GmailApp.getUserLabelByName('DC-Notified');
  if (!notified) notified = GmailApp.createLabel('DC-Notified');

  // Only threads labeled by the user's filters and not yet forwarded.
  var threads = GmailApp.search('label:DC-Notify -label:DC-Notified', 0, 20);

  for (var i = 0; i < threads.length; i++) {
    var thread = threads[i];
    var messages = thread.getMessages();
    var last = messages[messages.length - 1];

    // Forward only headers + a short snippet — never the full body.
    var payload = {
      from: last.getFrom(),
      subject: last.getSubject() || '(no subject)',
      snippet: (last.getPlainBody() || '').replace(/\s+/g, ' ').trim().slice(0, 140),
    };

    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-notify-secret': secret },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    // Only mark done on success so failures retry on the next run.
    if (response.getResponseCode() === 200) {
      thread.addLabel(notified);
    } else {
      console.warn('notify failed: HTTP ' + response.getResponseCode() + ' — will retry');
    }
  }
}
