// LIVE: replaying a release must not double-pay. Real PayPal sandbox, scripted model (the agent loop and rules gate are real).
import { readFileSync } from 'node:fs';
import { makePayPal } from '../backend/src/paypal.mjs';
import { memoryStore } from '../backend/src/store.mjs';
import { makeService } from '../backend/src/service.mjs';
import { makeAgent } from '../backend/src/agent.mjs';
import { scriptedBedrock } from '../backend/test/helpers.mjs';
for (const l of readFileSync(new URL('../../../.env', import.meta.url), 'utf8').split('\n')) { const m = l.match(/^([A-Z_]+)=(.*)$/); if (m) process.env[m[1]] ||= m[2]; }
const pp = makePayPal({ clientId: process.env.PAYPAL_CLIENT_ID, secret: process.env.PAYPAL_SECRET, api: process.env.PAYPAL_API });
let fail = 0; const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); if (!ok) fail++; };
const SALT = 'rp' + Date.now().toString(36).slice(-6);
const mkSvc = () => makeService({ store: memoryStore(), pp, agent: makeAgent({ client: scriptedBedrock('pass') }), env: { NO_REFERENCE: '1', SALT } });
const rep = { n: 1, report: 'x'.repeat(60), inspector: { name: 'R. Anselm', licence: 'NC-CI-1' }, signedOff: true };
const spy = []; const orig = pp.createPayout; pp.createPayout = async (b, r) => { try { const x = await orig(b, r); spy.push(['payout 201', b.sender_batch_header.sender_batch_id]); return x; } catch (e) { spy.push([`payout ${e.status} ${e.name}`, b.sender_batch_header.sender_batch_id]); throw e; } };
const oi = pp.createInvoice; pp.createInvoice = async (b, r) => { try { const x = await oi(b, r); spy.push(['invoice 201', b.detail.invoice_number]); return x; } catch (e) { spy.push([`invoice ${e.status}`, b.detail.invoice_number]); throw e; } };

console.log(`salt ${SALT}\n=== first release (service A)`);
const A = mkSvc(); const r1 = await A.inspect(rep);
check('first release created a batch', r1.released && !r1.batch.adopted, `batch ${r1.batch.id}, invoice ${r1.batch.invoiceId}`);
console.log('=== simulate a crash: a brand-new service with an EMPTY database replays the same release (same salt, so same ids)');
const B = mkSvc(); const r2 = await B.inspect(rep);
check('replay returned success, no error reached the caller', r2.released === true);
check('replay adopted the SAME PayPal batch', r2.batch.id === r1.batch.id && r2.batch.adopted === true, `${r2.batch.id}`);
check('replay adopted the SAME invoice', r2.batch.invoiceId === r1.batch.invoiceId && r2.batch.invoiceAdopted === true, r2.batch.invoiceId);
const bat = await pp.getBatch(r1.batch.id);
check('PayPal holds exactly one batch for that sender_batch_id with 2 items', bat.items.length === 2, `${bat.items.length} items`);
const t = await B.ledger.trial();
check('replay ledger is balanced and holds the right amounts', t.balanced && t.identityOk && t.fundedCents - t.heldCents === 1800000, JSON.stringify({ held: t.heldCents, transit: t.transitCents, paid: t.paidCents }));
console.log('=== PayPal calls made (a 400/422 here is the duplicate guard doing its job, then adopted):'); spy.forEach((s) => console.log('   ', s.join('  ')));
const sc = Object.fromEntries(spy.map(([k]) => [k, spy.filter(([x]) => x === k).length]));
check('exactly one 201 payout and one 201 invoice', sc['payout 201'] === 1 && sc['invoice 201'] === 1, JSON.stringify(sc));
for (const it of bat.items) if (it.transaction_status === 'UNCLAIMED') await pp.cancelItem(it.payout_item_id).catch(() => {});
console.log(fail ? `\n${fail} FAILED` : '\nALL REPLAY CHECKS PASSED'); process.exit(fail ? 1 : 0);
