// LIVE tests against the PayPal SANDBOX (fake money). Prints real output; exits non-zero on any failed assertion.
import { readFileSync } from 'node:fs';
import { makePayPal, PayPalError } from '../backend/src/paypal.mjs';
import { freshProject, planRelease, toPayoutBody, rollup, mapItem } from '../backend/src/domain.mjs';

for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ||= m[2]; }
const pp = makePayPal({ clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_SECRET, api: process.env.PAYPAL_API });
const tag = Date.now().toString(36);
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hdr = (t) => console.log(`\n=== ${t} ===`);
const table = (items) => items.forEach((i) => console.log(`   ${String(i.payout_item.sender_item_id).padEnd(34)} ${String(i.payout_item.receiver).padEnd(38)} $${i.payout_item.amount.value.padStart(6)}  ${i.transaction_status.padEnd(10)} ${i.errors?.name || ''}`));

async function pollTerminal(id, label) {
  const t0 = Date.now(); let last;
  for (let i = 0; i < 60; i++) {
    last = await pp.getBatch(id);
    const st = last.batch_header.batch_status; const items = last.items.map((x) => x.transaction_status);
    const settled = ['SUCCESS', 'DENIED', 'CANCELED'].includes(st) && items.every((s) => s !== 'PENDING' && s !== 'PROCESSING');
    process.stdout.write(`   poll ${String(i + 1).padStart(2)} t+${Math.round((Date.now() - t0) / 1000)}s batch=${st} items=[${[...new Set(items)].join(',')}]\n`);
    if (settled) break;
    await sleep(4000);
  }
  return last;
}

// ---- 0. live spec -----------------------------------------------------------
hdr('0. Live OpenAPI spec (https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json)');
const spec = await (await fetch('https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json')).json();
const sch = spec.components.schemas;
const req = JSON.stringify(sch.payout_item_request.properties.recipient_type);
console.log('   info.version            :', spec.info.version);
console.log('   payout_item_request_list:', 'minItems', sch.payout_item_request_list.minItems, 'maxItems', sch.payout_item_request_list.maxItems);
console.log('   recipient_enum (schema) :', JSON.stringify(sch.recipient_enum.enum));
console.log('   item recipient_type prose mentions USER_HANDLE:', req.includes('USER_HANDLE'), '| mentions VENMO_HANDLE:', req.includes('VENMO_HANDLE'));
const specText = JSON.stringify(spec);
console.log('   spec states a per-item $ cap?:', /per.?item.{0,40}(maximum|limit|cap)|20,000|60,000/i.test(specText) ? 'yes (see text)' : 'NO - the spec does not state a per-item dollar cap');
check('spec batch cap is 15000', sch.payout_item_request_list.maxItems === 15000);
check('schema enum has exactly EMAIL, PHONE, PAYPAL_ID', JSON.stringify(sch.recipient_enum.enum) === JSON.stringify(['EMAIL', 'PHONE', 'PAYPAL_ID']));
check('request-prose lists a 4th value USER_HANDLE (enum does not)', req.includes('USER_HANDLE'));

// ---- 1. headline: GC + four subs in ONE batch --------------------------------
hdr('1. HEADLINE: one batch pays the general contractor and four subcontractors (milestone 3 at the sandbox scale, 1:2500)');
const project = freshProject({}, 1);
project.payees.forEach((p) => { p.receiver = `${p.id}.${tag}@example.com`; });
const m3 = project.milestones[2];
const items = planRelease(project, m3);
const body = toPayoutBody(project, m3, items, `live-m3-${tag}`);
console.log('   request items:', body.items.length, '| sum $' + body.items.reduce((a, i) => a + Number(i.amount.value), 0).toFixed(2));
const created = await pp.createPayout(body);
const bid = created.batch_header.payout_batch_id;
console.log('   created batch', bid, 'status', created.batch_header.batch_status);
check('one POST created one batch', !!bid);
const done = await pollTerminal(bid, 'headline');
console.log('   batch_header:', JSON.stringify({ id: bid, status: done.batch_header.batch_status, amount: done.batch_header.amount, fees: done.batch_header.fees, funding: done.batch_header.funding_source }));
table(done.items);
check('batch has 5 items', done.items.length === 5);
check('batch reached a terminal status', ['SUCCESS', 'DENIED', 'CANCELED'].includes(done.batch_header.batch_status), done.batch_header.batch_status);
check('every item left PENDING (all 5 have a settled status)', done.items.every((i) => !['PENDING', 'PROCESSING'].includes(i.transaction_status)));
const delivered = done.items.filter((i) => i.transaction_status === 'SUCCESS').length;
console.log(`   NOTE: ${delivered}/5 SUCCESS; the others are ${[...new Set(done.items.filter((i) => i.transaction_status !== 'SUCCESS').map((i) => i.transaction_status + '/' + (i.errors?.name || '-')))].join(', ') || 'none'}.`);
console.log('   NOTE: batch_status says', done.batch_header.batch_status, 'but items delivered =', delivered, '- batch status is NOT delivery.');
const rl = rollup(done.items.map((i) => ({ status: i.transaction_status })));
check('rollup() agrees with the raw items', rl.delivered === delivered && rl.total === 5, JSON.stringify(rl));
// single item GET
const first = done.items[0];
const one = await pp.getItem(first.payout_item_id);
check('GET /payouts-item/{id} returns the same item', one.payout_item_id === first.payout_item_id && one.transaction_status === first.transaction_status, `${one.payout_item_id} ${one.transaction_status}`);

// ---- 2. idempotency -----------------------------------------------------------
hdr('2. Duplicate sender_batch_id is rejected (PayPal 30-day idempotency)');
try { await pp.createPayout(body); check('duplicate batch rejected', false, 'it was accepted!'); }
catch (e) { check('duplicate batch rejected', e instanceof PayPalError, `${e.status} ${e.name}: ${e.message.slice(0, 120)}`); }

// ---- 3. invalid recipient -----------------------------------------------------
hdr('3. Invalid recipient: whole batch refused, nothing created');
const bad = structuredClone(body); bad.sender_batch_header.sender_batch_id = `live-bad-${tag}`; bad.items[2].receiver = 'not-an-email';
try { await pp.createPayout(bad); check('invalid recipient rejected', false, 'accepted!'); }
catch (e) { check('invalid recipient rejected with VALIDATION_ERROR', e.name === 'VALIDATION_ERROR', `${e.status} ${JSON.stringify(e.details)}`); }

// ---- 4. insufficient funds ----------------------------------------------------
hdr('4. Escrow underfunded: INSUFFICIENT_FUNDS');
try { await pp.createPayout({ sender_batch_header: { sender_batch_id: `live-big-${tag}` }, items: [{ recipient_type: 'EMAIL', receiver: `big.${tag}@example.com`, amount: { currency: 'USD', value: '250000.00' } }] }); check('over-balance payout rejected', false, 'a $250,000 payout was ACCEPTED'); }
catch (e) { check('over-balance payout rejected with INSUFFICIENT_FUNDS', e.name === 'INSUFFICIENT_FUNDS', `${e.status} ${e.name}`); }

// ---- 5. unclaimed -> cancel ---------------------------------------------------
hdr('5. Unclaimed payout: detect UNCLAIMED, cancel it, confirm money is released back');
const unc = done.items.find((i) => i.transaction_status === 'UNCLAIMED');
if (!unc) console.log('   (no UNCLAIMED item in the headline batch - skipped)');
else {
  console.log('   cancelling', unc.payout_item_id, unc.payout_item.receiver);
  const c = await pp.cancelItem(unc.payout_item_id);
  console.log('   cancel response status:', c.transaction_status);
  const after = await pp.getItem(unc.payout_item_id);
  check('cancelled item is no longer UNCLAIMED', after.transaction_status !== 'UNCLAIMED', after.transaction_status + ' ' + (after.errors?.name || ''));
  try { await pp.cancelItem(unc.payout_item_id); check('second cancel refused', false); }
  catch (e) { check('second cancel refused', e instanceof PayPalError, `${e.status} ${e.name}`); }
  const succ = done.items.find((i) => i.transaction_status === 'SUCCESS');
  if (succ) { try { await pp.cancelItem(succ.payout_item_id); check('cancel of a SUCCESS item refused', false); } catch (e) { check('cancel of a SUCCESS item refused', true, `${e.status} ${e.name}`); } }
}

// ---- 6. partial failure via PayPal's canned test ids --------------------------
hdr('6. Partial failure (PayPal simulation ids; canned responses, NOT a real failed payment)');
for (const id of ['ERRPYO015', 'ERRPYO020', 'ERRPYOB004']) {
  try {
    const b = await pp.getBatch(id, { paged: false });
    console.log(`   GET /v1/payments/payouts/${id}: batch=${b.batch_header.batch_status} items=${b.items.map((i) => i.transaction_status + '/' + (i.errors?.name || '-')).join(' ')}`);
    const mapped = b.items.map((i) => mapItem({ payeeId: 'x', ledgerCents: 100 }, i));
    const r = rollup(mapped);
    check(`${id}: our rollup flags the failed item as needing attention`, r.failed > 0 && r.needsAttention, JSON.stringify(r));
  } catch (e) { console.log(`   ${id}: ${e.status} ${e.name} ${e.message.slice(0, 100)}`); }
}
try {
  const it = await pp.getItem('ERRPYO041');
  console.log('   GET /payouts-item/ERRPYO041:', it.transaction_status, it.errors?.name);
  check('item-level simulation returns a FAILED item with a named reason', it.transaction_status === 'FAILED' && !!it.errors?.name);
} catch (e) { console.log('   ERRPYO041:', e.status, e.name); }

// ---- 7. invoice ----------------------------------------------------------------
hdr('7. Invoice with line items tied to the milestone and the inspection record');
const inv = await pp.createInvoice({
  detail: { invoice_number: `ESC-LIVE-${tag}`.toUpperCase(), reference: 'INSP-LIVE', currency_code: 'USD', invoice_date: new Date().toISOString().slice(0, 10), note: 'Milestone 3 released on inspection INSP-LIVE', payment_term: { term_type: 'NET_30' } },
  invoicer: { name: { business_name: 'Milestone Escrow (sandbox)' } },
  primary_recipients: [{ billing_info: { name: { business_name: 'Whitfield family home rebuild' }, email_address: 'programme.sandbox@example.com' } }],
  items: body.items.map((i, n) => ({ name: `M3 ${project.payees[[0, 4, 5, 6, 2][n] ?? 0]?.trade || 'item'}`, quantity: '1', unit_amount: { currency_code: 'USD', value: i.amount.value } })),
});
const invId = inv.href.split('/').pop();
const got = await pp.getInvoice(invId);
console.log('   invoice', invId, 'status', got.status, 'reference', got.detail.reference, 'lines', got.items.length, 'amount', got.amount.value);
check('invoice has 5 milestone line items', got.items.length === 5);
check('invoice carries the inspection reference', got.detail.reference === 'INSP-LIVE');

console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : failures + ' LIVE CHECK(S) FAILED'}`);
process.exit(failures ? 1 : 0);
