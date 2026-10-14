// One-time QuickBooks company setup for DC Solar (2026-10-14, approved by Devon).
//
// QBO built the chart of accounts from a *utility* industry template. This
// replaces it with a solar-installer list: creates the accounts below (skips any
// that already exist by name), inactivates the utility-only ones, and dates the
// savings account's $100 opening balance to the books' start (2026-06-26).
//
//   node scripts/qbo/setup-accounts.mjs          → dry run (prints the plan)
//   node scripts/qbo/setup-accounts.mjs --apply  → does it
//
// Safe to re-run: every step checks the current state first.

import { qbo, query } from './qbo.mjs';

const APPLY = process.argv.includes('--apply');
const START = '2026-06-26';

// [name, AccountType, AccountSubType, parent name | null]
const CREATE = [
  ['Installation', 'Income', 'ServiceFeeIncome', null],
  ['Removal & reinstall (R&R)', 'Income', 'ServiceFeeIncome', null],
  ['Service plans & visits', 'Income', 'ServiceFeeIncome', null],
  ['Critter guard & add-ons', 'Income', 'ServiceFeeIncome', null],

  ['Job materials', 'Cost of Goods Sold', 'SuppliesMaterialsCogs', null],
  ['Subcontractors', 'Cost of Goods Sold', 'CostOfLaborCos', null],
  ['Job labor', 'Cost of Goods Sold', 'CostOfLaborCos', null],
  ['Job equipment rental', 'Cost of Goods Sold', 'EquipmentRentalCos', null],
  ['Permits & fees', 'Cost of Goods Sold', 'OtherCostsOfServiceCos', null],
  ['Job fuel & travel', 'Cost of Goods Sold', 'OtherCostsOfServiceCos', null],

  ['Fuel', 'Expense', 'Auto', 'Vehicle expenses'],
  ['Vehicle repairs & maintenance', 'Expense', 'Auto', 'Vehicle expenses'],
  ['Registration & title', 'Expense', 'Auto', 'Vehicle expenses'],
  ['Tools & small equipment', 'Expense', 'SuppliesMaterials', null],
  ['Software & phone', 'Expense', 'Utilities', null],
  ['Bank & card fees', 'Expense', 'BankCharges', null],

  ['Due to Isaiah Nettleton', 'Other Current Liability', 'OtherCurrentLiabilities', null],
];

// Utility-template accounts with no place in a solar installer's books.
// Sub-accounts first: QuickBooks refuses to inactivate a parent with active children.
const INACTIVATE = [
  'Connection revenue:Refunds & discounts to customers',
  'Utility service revenue:Refunds & discounts to customers',
  'Connection revenue',
  'Utility service revenue',
  'Purchased power',
  'Generation supplies',
  'Production energy',
  'Transmission and distribution',
  'Metering and service calls',
  'Other direct utility costs',
  'Indirect utility costs',
  'Direct service labor',
  'Contract labor – cost of sales',
  'Utility plant and infrastructure:Accumulated depreciation',
  'Utility plant and infrastructure',
  'Meters and service equipment:Accumulated depreciation',
  'Meters and service equipment',
];

// Clearer names for kept accounts.
const RENAME = [
  ['Payroll expenses:Wages', 'Office & overhead wages'],
  ['Payroll expenses:Taxes', 'Payroll taxes (employer)'],
];

const accounts = await query('select * from Account');
const byName = new Map(accounts.map((a) => [a.FullyQualifiedName, a]));
const log = (msg) => console.log(`${APPLY ? '' : '[dry run] '}${msg}`);

for (const [name, type, subType, parent] of CREATE) {
  const full = parent ? `${parent}:${name}` : name;
  if (byName.has(full)) {
    console.log(`= exists: ${full}`);
    continue;
  }
  const body = { Name: name, AccountType: type, AccountSubType: subType };
  if (parent) {
    const p = byName.get(parent);
    if (!p) throw new Error(`parent account missing: ${parent}`);
    Object.assign(body, { SubAccount: true, ParentRef: { value: p.Id } });
  }
  log(`+ create ${type} / ${full}`);
  if (APPLY) {
    const made = (await qbo('POST', 'account', body)).Account;
    byName.set(made.FullyQualifiedName, made);
  }
}

for (const full of INACTIVATE) {
  const a = byName.get(full);
  if (!a) {
    console.log(`? not found: ${full}`);
    continue;
  }
  if (!a.Active) {
    console.log(`= already inactive: ${full}`);
    continue;
  }
  if (Number(a.CurrentBalance) !== 0) {
    console.log(`! has a balance, left active: ${full} (${a.CurrentBalance})`);
    continue;
  }
  log(`- inactivate ${full}`);
  if (APPLY) await qbo('POST', 'account', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, Active: false, Name: a.Name });
}

for (const [full, newName] of RENAME) {
  const a = byName.get(full);
  if (!a) {
    console.log(`? not found: ${full}`);
    continue;
  }
  if (a.Name === newName) continue;
  log(`~ rename ${full} → ${newName}`);
  if (APPLY) await qbo('POST', 'account', { Id: a.Id, SyncToken: a.SyncToken, sparse: true, Name: newName });
}

// The savings account's $100 (Chase's account-opening bonus) was there before
// the books start; QBO dated its opening deposit the day the feed connected.
const savings = accounts.find((a) => a.AccountType === 'Bank' && /SAV/i.test(a.Name));
if (savings) {
  // DepositToAccountRef is not queryable; filter client-side.
  const deps = (await query('select * from Deposit')).filter((d) => d.DepositToAccountRef?.value === savings.Id);
  for (const d of deps) {
    const opening = d.Line?.every((l) => l.DepositLineDetail?.AccountRef?.name === 'Opening balance equity');
    if (opening && d.TxnDate !== START) {
      log(`~ savings opening balance ${d.TotalAmt}: ${d.TxnDate} → ${START}`);
      if (APPLY) {
        await qbo('POST', 'deposit', {
          Id: d.Id,
          SyncToken: d.SyncToken,
          sparse: true,
          TxnDate: START,
          DepositToAccountRef: d.DepositToAccountRef,
          Line: d.Line,
        });
      }
    }
  }
}

const prefs = (await qbo('GET', 'preferences')).Preferences;
const other = Object.fromEntries((prefs.OtherPrefs?.NameValue ?? []).map((n) => [n.Name, n.Value]));
console.log('\nProjects enabled:', other.ProjectsEnabled, '| track expenses by customer:', prefs.VendorAndPurchasesPrefs?.TrackingByCustomer);
