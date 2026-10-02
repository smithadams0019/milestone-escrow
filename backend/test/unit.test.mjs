import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.mjs';
import { makeService } from '../src/service.mjs';
import { gate } from '../src/bedrock.mjs';
import { makeAgent } from '../src/agent.mjs';
import { scriptedBedrock } from './helpers.mjs';
import { makeLedger } from '../src/ledger.mjs';
import { freshProject, planRelease, rollup, toPayoutBody, sandboxCents, isEmail, committedCents } from '../src/domain.mjs';
import { MILESTONES, TOTAL_CENTS, SAMPLE_REPORTS } from '../src/seed.mjs';

// ---- fakes: PayPal and Bedrock are replaced; the logic under test is ours ----
function fakePayPal({ failCreate, itemStatus = 'SUCCESS' } = {}) {
  const batches = new Map(); let n = 0; const calls = []; const cancelled = new Set();
  const stat = (it, i, id) => (cancelled.has(`${id}-I${i}`) ? 'RETURNED' : typeof itemStatus === 'function' ? itemStatus(it, i) : itemStatus);
  return {
    api: 'fake', calls, batches,
    async createPayout(body) {
      calls.push(['createPayout', body]);
      if (failCreate) throw Object.assign(new Error('x'), { name: failCreate, status: 422, body: { name: failCreate } });
      const sid = body.sender_batch_header.sender_batch_id;
      for (const b of batches.values()) if (b.sid === sid) throw Object.assign(new Error('dup'), { name: 'USER_BUSINESS_ERROR', status: 400, body: {}, details: [{ field: 'SENDER_BATCH_ID', link: [{ href: 'https://x/v1/payments/payouts/' + b.id }] }] });
      const id = 'B' + ++n;
      batches.set(id, { id, sid, body });
      return { batch_header: { payout_batch_id: id, batch_status: 'PENDING' } };
    },
    async getBatch(id) {
      const b = batches.get(id);
      const total = b.body.items.reduce((a, it) => a + Number(it.amount.value), 0);
      return { batch_header: { payout_batch_id: id, batch_status: 'SUCCESS', fees: { value: '0.10' }, amount: { currency: 'USD', value: total.toFixed(2) } },
        items: b.body.items.map((it, i) => ({ payout_item_id: `${id}-I${i}`, transaction_status: stat(it, i, id),
          payout_item: { sender_item_id: it.sender_item_id, amount: it.amount, receiver: it.receiver } })) };
    },
    async cancelItem(id) { calls.push(['cancel', id]); cancelled.add(id); return {}; },
    async createInvoice() { return { href: 'https://x/v2/invoicing/invoices/INV-1' }; },
    async verifyWebhook() { return { verification_status: 'FAILURE' }; },
  };
}
const mk = (opts = {}, mode = 'pass') => {
  const pp = fakePayPal(opts.pp); const store = memoryStore();
  const agent = makeAgent({ client: scriptedBedrock(mode) });
  return { pp, store, svc: makeService({ store, pp, agent, env: { RECIPIENTS_JSON: opts.recipients, NO_REFERENCE: opts.reference ? '' : '1', PAYPAL_WEBHOOK_ID: opts.webhookId } }) };
};
const rep = { report: 'x'.repeat(60), inspector: { name: 'A', licence: 'L1' }, signedOff: true };

test('seed: every milestone split sums to its total and the programme totals $120,000', () => {
  const p = freshProject();
  for (const m of p.milestones) assert.equal(m.splits.reduce((a, s) => a + s.cents, 0), m.totalCents);
  assert.equal(TOTAL_CENTS, 12000000);
  assert.equal(MILESTONES[2].splits.length, 5, 'headline milestone pays GC + four subs');
});

test('sandbox amounts equal ledger amounts (divisor 1) and always scale to whole cents', () => {
  for (const m of MILESTONES) for (const [, c] of m.splits) assert.equal((c / 1) % 1, 0);
  assert.equal(sandboxCents(1050000), 1050000);
});

test('planRelease rejects a bad receiver, a split mismatch, a tiny amount and an over-cap amount', () => {
  const p = freshProject(); const m = p.milestones[2];
  p.payees.find((x) => x.id === 'hvac').receiver = 'not-an-email';
  assert.throws(() => planRelease(p, m), { code: 'BAD_RECEIVER' });
  const p2 = freshProject(); const m2 = p2.milestones[2]; m2.splits[1].cents += 100;
  assert.throws(() => planRelease(p2, m2), { code: 'SPLIT_MISMATCH' });
  const p3 = freshProject(); const m3 = p3.milestones[2]; m3.splits[1].cents = 0; m3.totalCents = m3.splits.reduce((a, s) => a + s.cents, 0);
  assert.throws(() => planRelease(p3, m3), { code: 'AMOUNT_TOO_SMALL' });
  const p4 = freshProject(); const m4 = p4.milestones[0]; m4.splits[0].cents = 2000001 * 100 / 100 * 100; m4.totalCents = m4.splits.reduce((a, s) => a + s.cents, 0);
  assert.throws(() => planRelease(p4, m4), { code: 'ITEM_CAP' });
});

test('payout body: one batch, GC and four subs, EMAIL recipients, 2dp strings, deterministic item ids', () => {
  const p = freshProject(); const m = p.milestones[2]; const items = planRelease(p, m);
  const body = toPayoutBody(p, m, items, 'esc-x-m3');
  assert.equal(body.items.length, 5);
  assert.deepEqual(body.items.map((i) => i.amount.value), ['5000.00', '10500.00', '9000.00', '8000.00', '4500.00']);
  assert.ok(body.items.every((i) => i.recipient_type === 'EMAIL' && i.sender_item_id.startsWith(`whitfield-${p.salt}-m3-`)));
  assert.equal(body.sender_batch_header.sender_batch_id, 'esc-x-m3');
});

test('isEmail', () => { assert.ok(isEmail('a@b.co')); assert.ok(!isEmail('not-an-email')); assert.ok(!isEmail('a@b')); assert.ok(!isEmail('x'.repeat(130) + '@b.co')); });

test('rollup: a batch of UNCLAIMED items is not delivered', () => {
  const r = rollup([{ status: 'UNCLAIMED' }, { status: 'UNCLAIMED' }]);
  assert.equal(r.delivered, 0); assert.ok(r.needsAttention); assert.ok(r.settled); assert.ok(!r.allDelivered);
  const r2 = rollup([{ status: 'SUCCESS' }, { status: 'FAILED' }, { status: 'PENDING' }]);
  assert.deepEqual([r2.delivered, r2.failed, r2.inflight, r2.settled], [1, 1, 1, false]);
});

test('gate: blocks without sign-off, on FAIL, on low confidence, on missing licence', () => {
  const m = MILESTONES[2];
  const base = { decision: 'MET', confidence: 0.9, inspector_signoff_found: true, checklist: m.requirements.map((r) => ({ requirement: r, status: 'PASS' })) };
  assert.equal(gate(base, m, { signedOff: true }).releaseBlocked, false);
  assert.equal(gate(base, m, { signedOff: false }).releaseBlocked, true);
  assert.equal(gate({ ...base, confidence: 0.5 }, m, { signedOff: true }).releaseBlocked, true);
  assert.equal(gate({ ...base, inspector_signoff_found: false }, m, { signedOff: true }).releaseBlocked, true);
  const failed = { ...base, decision: 'MET', checklist: base.checklist.map((c, i) => (i === 1 ? { ...c, status: 'FAIL' } : c)) };
  assert.equal(gate(failed, m, { signedOff: true }).releaseBlocked, true, 'a model that says MET with a FAIL line still cannot release');
});

test('happy path: signed-off inspection releases GC + four subs in ONE PayPal call', async () => {
  const { svc, pp } = mk();
  await svc.inspect({ n: 1, ...rep }); await svc.inspect({ n: 2, ...rep });
  pp.calls.length = 0;
  const r = await svc.inspect({ n: 3, ...rep });
  assert.equal(r.released, true);
  assert.equal(pp.calls.filter((c) => c[0] === 'createPayout').length, 1);
  assert.equal(r.batch.items.length, 5);
  assert.equal(r.batch.invoiceId, 'INV-1');
  const v = await svc.view();
  assert.equal(v.milestones[2].state, 'released');
  assert.equal(v.milestones[3].state, 'awaiting');
  assert.equal(v.escrow.committedCents, 1800000 + 3000000 + 3700000);
});

test('milestones release in order', async () => {
  const { svc } = mk();
  await assert.rejects(svc.inspect({ n: 3, ...rep }), { code: 'LOCKED' });
});

test('a failed inspection moves no money, and the milestone stays open for re-inspection', async () => {
  let mode = 'fail';
  const { svc, pp } = mk({}, () => mode);
  const r1 = await svc.inspect({ n: 1, ...rep });
  assert.equal(r1.released, false); assert.equal(pp.calls.length, 0);
  assert.equal(r1.inspection.agent.outcome, 'withheld');
  assert.equal((await svc.view()).milestones[0].state, 'held');
  mode = 'pass';
  const r2 = await svc.inspect({ n: 1, ...rep });
  assert.equal(r2.released, true);
});

test('unsigned submission is held even if the model says MET', async () => {
  const { svc, pp } = mk();
  const r = await svc.inspect({ n: 1, ...rep, signedOff: false });
  assert.equal(r.released, false); assert.equal(pp.calls.length, 0);
});

test('AGENT REFUSAL: a model that tries to release while one requirement is FAIL is stopped by the rules gate; no payout is made', async () => {
  const { svc, pp } = mk({}, 'liar');
  const r = await svc.inspect({ n: 1, ...rep });
  assert.equal(r.released, false); assert.equal(pp.calls.filter((c) => c[0] === 'createPayout').length, 0);
  const t = r.inspection.agent.trace.map((x) => `${x.tool}:${x.status || ''}`);
  assert.ok(t.includes('release_milestone:error'), 'the release attempt was refused: ' + t.join(' '));
  assert.ok(t.includes('withhold_release:success'));
  assert.ok(r.inspection.agent.refusedAttempt.reasons.some((x) => /not shown as PASS/.test(x)));
});

test('AGENT REFUSAL: a report with no named licensed sign-off cannot release', async () => {
  const { svc, pp } = mk({}, 'nosignoff');
  const r = await svc.inspect({ n: 1, ...rep });
  assert.equal(r.released, false); assert.equal(pp.calls.length, 0);
});

test('AGENT: if the model never decides, the default is to withhold', async () => {
  const { svc, pp } = mk({}, 'silent');
  const r = await svc.inspect({ n: 1, ...rep });
  assert.equal(r.released, false); assert.equal(pp.calls.length, 0);
});

test('AGENT: the real loop runs tools first (4 reads) before any decision', async () => {
  const { svc } = mk();
  const r = await svc.inspect({ n: 1, ...rep });
  const tools = r.inspection.agent.trace.map((x) => x.tool);
  assert.deepEqual(tools.slice(0, 4), ['read_inspection_report', 'get_milestone_criteria', 'get_payment_tree', 'get_escrow_position']);
  assert.ok(tools.includes('compose_payout_batch') && tools.at(-1) === 'release_milestone');
});

test('double release: two concurrent inspections of the same milestone create exactly one PayPal batch', async () => {
  const { svc, pp } = mk();
  const res = await Promise.allSettled([svc.inspect({ n: 1, ...rep }), svc.inspect({ n: 1, ...rep })]);
  assert.equal(pp.calls.filter((c) => c[0] === 'createPayout').length, 1);
  assert.equal(res.filter((r) => r.status === 'fulfilled' && r.value.released).length, 1);
  assert.equal(res.filter((r) => r.status === 'rejected').length, 1);
});

test('PayPal refusal (INSUFFICIENT_FUNDS) un-locks the milestone, pays nobody, and is reported', async () => {
  const { svc } = mk({ pp: { failCreate: 'INSUFFICIENT_FUNDS' } });
  await assert.rejects(svc.inspect({ n: 1, ...rep }), { code: 'INSUFFICIENT_FUNDS' });
  const v = await svc.view();
  assert.equal(v.milestones[0].state, 'awaiting'); assert.equal(v.escrow.committedCents, 0);
});

test('an invalid recipient is caught before PayPal is called, and the milestone stays in escrow', async () => {
  const { svc, pp } = mk({ recipients: JSON.stringify({ gc: 'broken' }) });
  await assert.rejects(svc.inspect({ n: 1, ...rep }), { code: 'BAD_RECEIVER' });
  assert.equal(pp.calls.length, 0);
  assert.equal((await svc.view()).milestones[0].state, 'awaiting');
});

test('partial failure: one of five items fails, four deliver; milestone is released but flagged', async () => {
  const { svc } = mk({ pp: { itemStatus: (it, i) => (i === 3 ? 'FAILED' : 'SUCCESS') } });
  await svc.inspect({ n: 1, ...rep }); await svc.inspect({ n: 2, ...rep });
  await svc.inspect({ n: 3, ...rep });
  const v = await svc.view(); const m = v.milestones[2];
  assert.deepEqual([m.rollup.delivered, m.rollup.failed, m.rollup.needsAttention], [4, 1, true]);
  assert.equal(v.escrow.committedCents, 1800000 + 3000000 + 3700000 - 800000, 'a failed item returns to escrow');
});

test('unclaimed -> cancel -> reissue to a corrected address makes exactly one new payment', async () => {
  const { svc, pp } = mk({ pp: { itemStatus: 'UNCLAIMED' } });
  await svc.inspect({ n: 1, ...rep });
  const b = (await svc.view()).batches[0];
  await assert.rejects(svc.reissue({ n: 1, payeeId: 'gc', receiver: 'oops' }), { code: 'BAD_RECEIVER' });
  pp.batches.forEach((x) => { x.cancelledFlag = false; });
  await svc.reissue({ n: 1, payeeId: 'gc', receiver: 'right@example.org' });
  assert.ok(pp.calls.some((c) => c[0] === 'cancel'));
  const batches = (await svc.view()).batches;
  assert.equal(batches.length, 2);
  assert.equal(batches[1].items[0].receiver, 'right@example.org');
});

test('cancel refuses anything that is not UNCLAIMED', async () => {
  const { svc } = mk({ pp: { itemStatus: 'SUCCESS' } });
  await svc.inspect({ n: 1, ...rep });
  const b = (await svc.view()).batches[0];
  await assert.rejects(svc.cancelItem(b.id, 'gc'), { code: 'NOT_UNCLAIMED' });
});

test('webhook is a nudge: an unverified event cannot change state by itself, it only triggers a re-read', async () => {
  const { svc, pp, store } = mk({ pp: { itemStatus: 'PENDING' } });
  await svc.inspect({ n: 1, ...rep });
  const b = (await svc.view()).batches[0];
  const r = await svc.webhook({ headers: {}, rawBody: JSON.stringify({ id: 'WH-1', event_type: 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', resource: { payout_batch_id: b.id, transaction_status: 'SUCCESS' } }) });
  assert.equal(r.verified, false);
  assert.match(r.action, /re-read/);
  // forged event for a batch we never made: recorded, nothing refreshed
  const r2 = await svc.webhook({ headers: {}, rawBody: JSON.stringify({ id: 'WH-2', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: 'FORGED' } } }) });
  assert.equal(r2.action, 'recorded');
});

test('reset returns to a clean ledger with a new run number', async () => {
  const { svc } = mk();
  await svc.inspect({ n: 1, ...rep });
  const v = await svc.reset();
  assert.equal(v.project.run, 2); assert.equal(v.escrow.committedCents, 0);
});

test('sample reports exist for the demo milestone, including the adversarial one', () => {
  assert.ok(SAMPLE_REPORTS[3].pass && SAMPLE_REPORTS[3].fail && SAMPLE_REPORTS[3].injection);
});

test('with the reference run enabled, a fresh project starts with milestone 1 already released from a real batch', async () => {
  const { svc } = mk({ reference: true });
  const v = await svc.view();
  assert.equal(v.milestones[0].state, 'released'); assert.equal(v.milestones[1].state, 'awaiting');
  assert.match(v.batches[0].id, /^[A-Z0-9]{10,}$/);
});

// ---------------- ledger ----------------
test('LEDGER: every release is balanced; held + in transit + paid always equals funded', async () => {
  const { svc } = mk({ pp: { itemStatus: 'SUCCESS' } });
  await svc.inspect({ n: 1, ...rep }); await svc.inspect({ n: 2, ...rep });
  const t = (await svc.view()).ledger.trial;
  assert.equal(t.balanced, true); assert.equal(t.identityOk, true);
  assert.equal(t.fundedCents, 12000000); assert.equal(t.heldCents, 12000000 - 4800000);
  assert.equal(t.paidCents, 4800000); assert.equal(t.transitCents, 0);
});

test('LEDGER: unclaimed money stays in transit, and a returned payment moves back to escrow as a new balanced entry', async () => {
  let st = 'UNCLAIMED';
  const { svc, pp } = mk({ pp: { itemStatus: () => st } });
  await svc.inspect({ n: 1, ...rep });
  let t = (await svc.view()).ledger.trial;
  assert.equal(t.transitCents, 1800000); assert.equal(t.paidCents, 0);
  st = 'RETURNED';
  const b = (await svc.view()).batches[0]; await svc.refreshBatch(b.id);
  t = (await svc.view()).ledger.trial;
  assert.equal(t.transitCents, 0); assert.equal(t.heldCents, 12000000); assert.equal(t.balanced, true);
});

test('LEDGER: syncing the same PayPal state twice posts nothing twice (replay-safe)', async () => {
  const { svc } = mk({ pp: { itemStatus: 'SUCCESS' } });
  await svc.inspect({ n: 1, ...rep });
  const b = (await svc.view()).batches[0];
  const before = (await svc.ledger.trial()).entries;
  await svc.refreshBatch(b.id); await svc.refreshBatch(b.id);
  assert.equal((await svc.ledger.trial()).entries, before);
});

test('LEDGER: a PayPal failure after landing is reversed, not lost', async () => {
  let st = 'SUCCESS';
  const { svc } = mk({ pp: { itemStatus: () => st } });
  await svc.inspect({ n: 1, ...rep });
  st = 'REFUNDED'; await svc.refreshBatch((await svc.view()).batches[0].id);
  const t = (await svc.ledger.trial());
  assert.equal(t.heldCents, 12000000); assert.equal(t.paidCents, 0); assert.ok(t.balanced);
});

test('RECONCILE: clean when ledger and PayPal agree; drift is reported when they do not', async () => {
  const { svc, pp } = mk({ pp: { itemStatus: 'SUCCESS' } });
  await svc.inspect({ n: 1, ...rep });
  let rec = await svc.reconcile();
  assert.equal(rec.ok, true, JSON.stringify(rec.drift));
  // tamper 1: PayPal now says an item amount differs from what the ledger paid
  const origGet = pp.getBatch.bind(pp);
  pp.getBatch = async (id) => { const r = await origGet(id); r.items[0].payout_item.amount = { currency: 'USD', value: '999.00' }; return r; };
  rec = await svc.reconcile();
  assert.equal(rec.ok, false);
  assert.ok(rec.drift.some((d) => d.check === 'amount'));
  // tamper 2: an unknown PayPal status is flagged, never guessed
  pp.getBatch = async (id) => { const r = await origGet(id); r.items[1].transaction_status = 'SOMETHING_NEW'; return r; };
  rec = await svc.reconcile();
  assert.ok(rec.drift.some((d) => d.check === 'unknown-paypal-status'));
});

test('LEDGER: an unbalanced entry is refused at the door', async () => {
  const { svc } = mk();
  await assert.rejects(svc.ledger.post({ key: 'bad', at: new Date().toISOString(), kind: 'x', ref: {}, lines: [{ account: 'a', side: 'DR', cents: 5 }, { account: 'b', side: 'CR', cents: 4 }] }), /unbalanced/);
});

// ---------------- idempotency & recovery ----------------
test('IDEMPOTENCY: every payout and invoice carries a PayPal-Request-Id equal to the deterministic sender_batch_id', async () => {
  const reqIds = []; const { svc, pp } = mk();
  const orig = pp.createPayout.bind(pp); pp.createPayout = async (b, rid) => { reqIds.push([b.sender_batch_header.sender_batch_id, rid]); return orig(b, rid); };
  await svc.inspect({ n: 1, ...rep });
  assert.equal(reqIds.length, 1); assert.match(reqIds[0][0], /^esc-[0-9a-f]{6}-m1$/); assert.equal(reqIds[0][0], reqIds[0][1]);
});

test('IDEMPOTENCY: crash between PayPal accepting the batch and us recording it - the retry ADOPTS the existing batch and pays nobody twice', async () => {
  const { svc, pp } = mk();
  // simulate the lost response: PayPal has the batch, our store does not
  const project = await svc.ensureProject();
  const { toPayoutBody, planRelease } = await import('../src/domain.mjs');
  const m = project.milestones[0];
  await pp.createPayout(toPayoutBody(project, m, planRelease(project, m), `esc-${project.salt}-m1`));
  pp.createPayout = ((orig) => async (body, rid) => {
    try { return await orig(body, rid); } catch (e) { throw Object.assign(e, { details: [{ field: 'SENDER_BATCH_ID', link: [{ href: 'https://x/v1/payments/payouts/B1' }] }] }); }
  })(pp.createPayout.bind(pp));
  const r = await svc.inspect({ n: 1, ...rep });
  assert.equal(r.released, true); assert.equal(r.batch.id, 'B1'); assert.equal(r.batch.adopted, true);
  assert.equal([...pp.batches.keys()].length, 1, 'PayPal still holds exactly one batch');
});

test('RETRY: re-issue is refused while the old payment could still land (pending/success)', async () => {
  const { svc } = mk({ pp: { itemStatus: 'PENDING' } });
  await svc.inspect({ n: 1, ...rep });
  await assert.rejects(svc.reissue({ n: 1, payeeId: 'gc', receiver: 'new@example.org' }), { code: 'NOT_RETRYABLE' });
});

test('RETRY: a double-click on re-issue cannot pay twice (same derived sender_batch_id)', async () => {
  const { svc, pp } = mk({ pp: { itemStatus: (it) => (it.sender_item_id.includes('try') ? 'PENDING' : 'FAILED') } });
  await svc.inspect({ n: 1, ...rep });
  const one = svc.reissue({ n: 1, payeeId: 'gc', receiver: 'new@example.org' });
  await one;
  // second click: the old item is FAILED (dead) but a try1 payment now exists; the derived id is try2 now, so guard by status
  await assert.rejects(svc.reissue({ n: 1, payeeId: 'gc', receiver: 'new@example.org' }), (e) => ['NOT_RETRYABLE', 'DUPLICATE_REISSUE'].includes(e.code));
  assert.equal([...pp.batches.values()].filter((b) => b.sid.includes('-gc-try')).length, 1);
});

// ---------------- webhooks ----------------
test('WEBHOOK: with a webhook id configured, an event whose signature does not verify is rejected 401 and changes nothing', async () => {
  const { svc, pp } = mk({ webhookId: 'WH-ID', pp: { itemStatus: 'PENDING' } });
  await svc.inspect({ n: 1, ...rep });
  const b = (await svc.view()).batches[0];
  const before = pp.calls.length;
  await assert.rejects(svc.webhook({ headers: {}, rawBody: JSON.stringify({ id: 'X', event_type: 'PAYMENT.PAYOUTSBATCH.SUCCESS', resource: { batch_header: { payout_batch_id: b.id } } }) }), { code: 'SIGNATURE_INVALID', status: 401 });
  const evs = (await svc.view()).events;
  assert.ok(evs.some((e) => /REJECTED/.test(e.text)));
});

test('IDEMPOTENCY: adopting an existing batch is refused when its recipients or amounts differ (id collision)', async () => {
  const { svc, pp } = mk();
  const project = await svc.ensureProject();
  const { toPayoutBody, planRelease } = await import('../src/domain.mjs');
  const m = project.milestones[0]; const body = toPayoutBody(project, m, planRelease(project, m), `esc-${project.salt}-m1`);
  body.items[0].amount.value = '1.23'; // a different payment under the same sender_batch_id
  await pp.createPayout(body);
  await assert.rejects(svc.inspect({ n: 1, ...rep }), { code: 'BATCH_ID_COLLISION' });
  assert.equal((await svc.view()).milestones[0].state, 'awaiting');
});

test('AGENT: when the primary model is throttled the run moves to the fallback model, records it, and the gate still decides', async () => {
  const inner = scriptedBedrock('pass'); const seen = [];
  const client = { async send(cmd) { seen.push(cmd.input.modelId); if (cmd.input.modelId.startsWith('us.')) throw Object.assign(new Error('Too many requests, please wait before trying again.'), { name: 'ThrottlingException' }); return inner.send(cmd); } };
  const agent = makeAgent({ client, retry: { tries: 2, base: 1 } });
  const pp = fakePayPal(); const store = memoryStore();
  const svc = makeService({ store, pp, agent, env: { NO_REFERENCE: '1' } });
  const r = await svc.inspect({ n: 1, ...rep });
  assert.equal(r.released, true);
  assert.equal(r.inspection.verdict.modelId.startsWith('global.'), true);
  assert.ok(seen.filter((m) => m.startsWith('us.')).length === 2, 'primary tried twice before falling back');
});
