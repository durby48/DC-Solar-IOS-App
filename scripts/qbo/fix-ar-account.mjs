// 2026-10-14: the utility-industry template made a SECOND A/R account,
// "Accounts receivable:Allowance for doubtful accounts", with the ordinary
// AccountsReceivable detail type, and QuickBooks posted every imported invoice and
// payment to it. Sparse updates of ARAccountRef on existing invoices are silently
// ignored by the API, so instead the account is renamed and moved to the top level:
// it IS the company's receivables account. The empty original is renamed out of the way.
// Idempotent.
import { qbo, query } from './qbo.mjs';

const accts = await query("select * from Account where AccountType = 'Accounts Receivable'");
const used = accts.find((a) => a.Name === 'Allowance for doubtful accounts');
const empty = accts.find((a) => a.FullyQualifiedName === 'Accounts receivable' && Number(a.CurrentBalance) === 0);
if (empty && used) {
  await qbo('POST', 'account', { Id: empty.Id, SyncToken: empty.SyncToken, sparse: true, Name: 'Accounts receivable (unused)' });
  console.log('renamed the empty original → "Accounts receivable (unused)"');
}
if (used) {
  const fresh = (await query(`select * from Account where Id = '${used.Id}'`))[0];
  await qbo('POST', 'account', { Id: fresh.Id, SyncToken: fresh.SyncToken, sparse: true, Name: 'Accounts receivable', SubAccount: false, ParentRef: null });
  console.log('renamed "Allowance for doubtful accounts" → "Accounts receivable" (top level)');
}
for (const a of await query("select * from Account where AccountType = 'Accounts Receivable'")) {
  console.log(`  ${a.Id} ${a.FullyQualifiedName} ${a.CurrentBalance}`);
}
if (empty) {
  try {
    const e = (await query(`select * from Account where Id = '${empty.Id}'`))[0];
    await qbo('POST', 'account', { Id: e.Id, SyncToken: e.SyncToken, sparse: true, Name: e.Name, Active: false });
    console.log('hid the unused one');
  } catch (err) {
    console.log(`could not hide the unused one (${err.message.slice(0, 100)}) — harmless, it stays at $0`);
  }
}
