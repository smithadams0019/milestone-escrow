import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Conflict } from './store.mjs';
import { SAMPLE_REPORTS } from './seed.mjs';
import { freshProject, milestoneState, planRelease, toPayoutBody, rollup, mapItem, dollars, sandboxCents, isEmail, TERMINAL_BATCH } from './domain.mjs';
import { makeLedger, RETURNED } from './ledger.mjs';
import { existingBatchId, isDuplicateInvoice } from './paypal.mjs';

const httpErr = (status, code, message, extra = {}) => Object.assign(new Error(message), { status, code, ...extra });
const STALE_LOCK_MS = 120000;
const UNCLAIMED_RETURN_DAYS = 30; // PayPal returns an unclaimed payout to the sender after 30 days
const DAY = 86400000;

export function makeService({ store, pp, agent, env = {}, now = () => new Date() }) {
  const iso = () => now().toISOString();
  const ledger = makeLedger(store, { now });

  async function loadReference() {
    if (env.NO_REFERENCE) return null;
    try { return JSON.parse(await readFile(fileURLToPath(new URL('./reference-m1.json', import.meta.url)), 'utf8')); } catch { return null; }
  }
  async function event(kind, text, data = {}) {
    const at = iso();
    await store.put(`EVT#${at}#${randomUUID().slice(0, 6)}`, { at, kind, text, ...data });
  }
  async function mutate(fn, tries = 4) {
    for (let i = 0; i < tries; i++) {
      const project = await ensureProject();
      try { return await fn(project); } catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    throw httpErr(409, 'CONFLICT', 'The ledger changed underneath this request. Try again.');
  }
  async function ensureProject() {
    let p = await store.getProject();
    if (p) return p;
    p = freshProject(env, 1);
    let created = false;
    try { p = await store.putProject(p, { create: true }); created = true; } catch (e) { if (!(e instanceof Conflict)) throw e; p = await store.getProject(); }
    if (created) { await ledger.fund(p.fundedCents); await applyReference(p); }
    return store.getProject();
  }
  async function applyReference(p) {
    const ref = await loadReference();
    if (!ref || p.milestones[0].status === 'released') return;
    await store.put(`INSP#${ref.inspection.id}`, ref.inspection);
    await store.put(`BATCH#${ref.batch.id}`, ref.batch);
    await ledger.syncBatch(ref.batch);
    const next = structuredClone(p);
    Object.assign(next.milestones[0], { status: 'released', verdict: ref.inspection.verdict, inspectionId: ref.inspection.id, batchId: ref.batch.id, invoiceId: ref.batch.invoiceId, releasedAt: ref.batch.createdAt, reference: true });
    await applyRefusal(next);
    await store.putProject(next);
    await event('release', 'Milestone 1 was released in a real sandbox batch before this session (reference run).', { n: 1 });
  }

  // Milestone 2 opens held, carrying a verdict the model really returned when it
  // was given a report that proved two of its four requirements. It is the first
  // thing anyone sees, because a release that is withheld is the whole point.
  async function applyRefusal(p) {
    let ref;
    try { ref = JSON.parse(await readFile(fileURLToPath(new URL('./reference-m2-refused.json', import.meta.url)), 'utf8')); }
    catch { return; }
    if (!ref?.inspection) return;
    const m = p.milestones.find((x) => x.n === 2);
    if (!m || m.status === 'released') return;
    await store.put(`INSP#${ref.inspection.id}`, ref.inspection);
    // The caller writes the project; writing it here too loses the version race.
    Object.assign(m, { status: 'held', verdict: ref.inspection.verdict, inspectionId: ref.inspection.id });
    await event('held', 'Milestone 2 was not released: the inspection report proved two of four requirements.', { n: 2 });
  }

  // ---------- views ----------
  function latestItems(m, batches) {
    const byPayee = new Map();
    for (const b of batches.filter((x) => x.milestone === m.n).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) for (const it of b.items) byPayee.set(it.payeeId, { ...it, batchId: b.id });
    return m.splits.map((s) => byPayee.get(s.payee)).filter(Boolean);
  }
  function unclaimedInfo(it) {
    if (it.status !== 'UNCLAIMED') return null;
    const since = Date.parse(it.processedAt || it.firstSeenUnclaimed || 0) || now().getTime();
    const age = Math.floor((now().getTime() - since) / DAY);
    return { daysUnclaimed: age, daysUntilReturned: Math.max(0, UNCLAIMED_RETURN_DAYS - age), stale: age >= 7 };
  }

  async function view() {
    const project = await ensureProject();
    const [batches, inspections, events, trial, recon, journal] = await Promise.all([
      store.list('BATCH#'), store.list('INSP#', { reverse: true, limit: 20 }), store.list('EVT#', { reverse: true, limit: 40 }), ledger.trial(), store.get('RECON'), ledger.all(),
    ]);
    const milestones = project.milestones.map((m) => {
      const items = latestItems(m, batches).map((it) => ({ ...it, unclaimed: unclaimedInfo(it) }));
      return { ...m, state: milestoneState(project, m), items, rollup: items.length ? rollup(items) : null };
    });
    return {
      project: { id: project.id, run: project.run, title: project.title, place: project.place, divisor: project.divisor, payees: project.payees },
      escrow: { fundedCents: trial.fundedCents, committedCents: trial.fundedCents - trial.heldCents, deliveredCents: trial.paidCents, transitCents: trial.transitCents, remainingCents: trial.heldCents },
      ledger: { trial, recon, entries: journal.slice(-40).reverse() },
      milestones, batches,
      inspections: inspections.map(({ report, ...rest }) => ({ ...rest, reportPreview: String(report || '').slice(0, 200) })),
      events, samples: SAMPLE_REPORTS, mode: { paypal: pp.api, store: store.kind },
    };
  }

  // ---------- PayPal sync ----------
  async function refreshBatchLive(batchId) {
    const batch = await store.get(`BATCH#${batchId}`);
    if (!batch) throw httpErr(404, 'NO_BATCH', 'unknown batch');
    const live = await pp.getBatch(batchId);
    const header = live.batch_header || {};
    const byId = new Map((live.items || []).map((i) => [i.payout_item?.sender_item_id, i]));
    batch.items = batch.items.map((it) => {
      const l = byId.get(it.senderItemId); if (!l) return it;
      const m = mapItem(it, l);
      if (m.status === 'UNCLAIMED' && !m.firstSeenUnclaimed) m.firstSeenUnclaimed = iso();
      return m;
    });
    batch.status = header.batch_status || batch.status;
    batch.fees = header.fees?.value ?? batch.fees ?? null;
    batch.timeCompleted = header.time_completed || batch.timeCompleted || null;
    batch.refreshedAt = iso();
    await store.put(`BATCH#${batchId}`, batch);
    const posted = await ledger.syncBatch(batch);
    for (const k of posted) if (k.startsWith('return:') || k.startsWith('reverse:')) await event('return', `PayPal returned a payment (${k.split(':')[1]}); the money is back in escrow.`, { batchId });
    return { batch, live };
  }
  const refreshBatch = async (id) => (await refreshBatchLive(id)).batch;

  async function reconcile() {
    const project = await ensureProject();
    const batches = await store.list('BATCH#'); const live = new Map();
    for (const b of batches) { try { const r = await refreshBatchLive(b.id); live.set(b.id, r.live); } catch (e) { /* missing -> drift */ } }
    const fresh = await store.list('BATCH#');
    const rec = await ledger.reconcile(fresh, live, project.divisor);
    await store.put('RECON', rec);
    if (!rec.ok) await event('drift', `Reconciliation found ${rec.drift.length} difference(s) between the ledger and PayPal.`, {});
    return rec;
  }

  async function refreshOpen() {
    const batches = await store.list('BATCH#');
    const open = batches.filter((b) => !(TERMINAL_BATCH.has(b.status) && rollup(b.items).settled));
    const out = [];
    for (const b of open.slice(0, 6)) { try { out.push(await refreshBatch(b.id)); } catch (e) { out.push({ id: b.id, error: e.message }); } }
    return out;
  }

  // ---------- the agent-driven release ----------
  async function inspect({ n, report, inspector, signedOff }) {
    if (!(await store.bump('inspect-' + iso().slice(0, 10), Number(env.DAILY_INSPECT_LIMIT || 400)))) throw httpErr(429, 'QUOTA', 'Daily demo limit reached.');
    n = Number(n);
    if (!report || typeof report !== 'string' || report.trim().length < 20) throw httpErr(400, 'BAD_REPORT', 'Provide the inspection report text.');
    if (report.length > 12000) throw httpErr(400, 'BAD_REPORT', 'Report is over 12,000 characters.');
    const project = await ensureProject();
    const m = project.milestones.find((x) => x.n === n);
    if (!m) throw httpErr(404, 'NO_MILESTONE', 'No such milestone.');
    const state = milestoneState(project, m);
    if (state === 'locked') throw httpErr(409, 'LOCKED', `Milestone ${n - 1} must be released first.`);
    if (state === 'released') throw httpErr(409, 'ALREADY_RELEASED', `Milestone ${n} is already released.`);
    if (state === 'releasing') throw httpErr(409, 'RELEASING', `Milestone ${n} is mid-release.`);

    const id = 'INSP-' + randomUUID().slice(0, 8).toUpperCase();
    const inspection = { id, n, at: iso(), inspector: inspector || null, signedOff: !!signedOff, report };
    const nameOf = (pid) => project.payees.find((p) => p.id === pid);
    const ctx = {
      milestone: m, report, inspector, signedOff: !!signedOff,
      tree: async () => ({ milestone_total_usd: m.totalCents / 100, payees: m.splits.map((s) => { const p = nameOf(s.payee); return { payee_id: p.id, name: p.name, role: p.tier === 1 ? 'general contractor' : 'subcontractor', trade: p.trade, owed_usd: s.cents / 100, payout_address_valid: isEmail(p.receiver) }; }) }),
      position: async () => { const t = await ledger.trial(); return { held_in_escrow_usd: t.heldCents / 100, this_milestone_usd: m.totalCents / 100, sufficient: t.heldCents >= m.totalCents, already_released_usd: (t.fundedCents - t.heldCents) / 100, earlier_milestones_released: project.milestones.filter((x) => x.n < n).every((x) => x.status === 'released') }; },
      plan: async () => { const items = planRelease(project, m); const t = await ledger.trial(); if (t.heldCents < m.totalCents) throw Object.assign(new Error('escrow holds less than this milestone'), { code: 'ESCROW_UNDERFUNDED' }); return { items: items.map((i) => ({ payee_id: i.payeeId, usd_ledger: i.ledgerCents / 100, usd_sandbox: i.sandboxCents / 100 })), item_count: items.length, single_batch: true }; },
      release: async (assessment, g) => {
        inspection.verdict = { ...assessment, releaseBlocked: false, reasons: [] };
        return release(n, inspection);
      },
    };
    let result;
    try { result = await agent(ctx); }
    catch (e) { if (e.status) throw e; throw httpErr(502, 'AGENT_ERROR', 'The review agent failed, so nothing was released: ' + e.message); }

    inspection.verdict = { ...result.assessment, releaseBlocked: result.outcome !== 'released', reasons: result.gate?.reasons || [], modelId: result.modelId, usage: result.usage };
    inspection.agent = { outcome: result.outcome, turns: result.turns, trace: result.trace, refusedAttempt: result.attemptedReleaseRefused };
    await store.put(`INSP#${id}`, inspection);
    await mutate(async (p) => {
      const mm = p.milestones.find((x) => x.n === n);
      if (mm.status === 'pending') { mm.verdict = inspection.verdict; mm.inspectionId = id; await store.putProject(p); }
    });
    const { report: _r, ...pub } = inspection;
    if (result.outcome === 'released') {
      await event('verdict', `Milestone ${n}: agent confirmed all ${m.requirements.length} requirements and released.`, { n });
      return { inspection: pub, released: true, batch: result.batch };
    }
    await event('held', `Milestone ${n} withheld by the agent. ${result.gate.reasons[0] || ''}`, { n });
    return { inspection: pub, released: false, reasons: result.gate.reasons };
  }

  async function release(n, inspection) {
    const { project, m } = await mutate(async (p) => {
      const mm = p.milestones.find((x) => x.n === n);
      const stale = mm.status === 'releasing' && Date.now() - Date.parse(mm.releasingAt || 0) > STALE_LOCK_MS;
      if (mm.status === 'released' || (mm.status === 'releasing' && !stale)) throw httpErr(409, 'ALREADY_RELEASED', `Milestone ${n} is already released or releasing.`);
      const prev = p.milestones.find((x) => x.n === n - 1);
      if (prev && prev.status !== 'released') throw httpErr(409, 'LOCKED', `Milestone ${n - 1} must be released first.`);
      mm.status = 'releasing'; mm.releasingAt = iso();
      const saved = await store.putProject(p);
      return { project: saved, m: saved.milestones.find((x) => x.n === n) };
    });
    const unlock = () => mutate(async (p) => { const mm = p.milestones.find((x) => x.n === n); if (mm.status === 'releasing') { mm.status = 'pending'; await store.putProject(p); } });

    let items;
    try { items = planRelease(project, m); } catch (e) { await unlock(); throw httpErr(422, e.code, e.message); }
    const trial = await ledger.trial();
    if (m.totalCents > trial.heldCents) { await unlock(); throw httpErr(422, 'ESCROW_UNDERFUNDED', 'Escrow balance is lower than this milestone.'); }

    // Idempotency: the same release always uses the same sender_batch_id AND the same PayPal-Request-Id.
    const senderBatchId = `esc-${project.salt}-m${n}`;
    let created, adopted = false;
    try {
      created = await pp.createPayout(toPayoutBody(project, m, items, senderBatchId), senderBatchId);
    } catch (e) {
      const prior = e.name === 'USER_BUSINESS_ERROR' ? existingBatchId(e) : null;
      if (prior) { // a previous attempt already created it: adopt it, never pay twice, but only if it is exactly what we meant to pay
        created = await pp.getBatch(prior); adopted = true;
        const want = new Map(toPayoutBody(project, m, items, senderBatchId).items.map((i) => [i.sender_item_id, i.amount.value + '|' + i.receiver]));
        const got = new Map((created.items || []).map((i) => [i.payout_item.sender_item_id, i.payout_item.amount.value + '|' + i.payout_item.receiver]));
        const same = want.size === got.size && [...want].every(([k, v]) => got.get(k) === v);
        if (!same) { await unlock(); throw httpErr(409, 'BATCH_ID_COLLISION', 'PayPal already holds a batch with this id but different recipients or amounts. Nothing was paid.'); }
      }
      else {
        await unlock();
        await event('error', `PayPal refused the batch for milestone ${n}: ${e.name}. Nothing was paid; the milestone is back in escrow.`, { n });
        throw httpErr(e.status === 422 || e.status === 400 ? 422 : 502, e.name, e.message, { paypal: e.body });
      }
    }
    const batchId = created.batch_header.payout_batch_id;
    const batch = {
      id: batchId, senderBatchId, requestId: senderBatchId, adopted, divisor: project.divisor, milestone: n, createdAt: iso(), status: created.batch_header.batch_status, inspectionId: inspection.id,
      invoiceId: null, invoiceError: null,
      items: items.map((it) => ({ ...it, senderItemId: `${project.id}-${project.salt}-m${n}-${it.payeeId}`, status: 'PENDING', itemId: null, error: null })),
    };
    await store.put(`BATCH#${batchId}`, batch);
    await ledger.syncBatch(batch);
    await mutate(async (p) => {
      const mm = p.milestones.find((x) => x.n === n);
      Object.assign(mm, { status: 'released', batchId, releasedAt: batch.createdAt, inspectionId: inspection.id, verdict: inspection.verdict });
      await store.putProject(p);
    });
    await event('release', `Milestone ${n} released: ${items.length} payments in one PayPal batch (${batchId})${adopted ? ' [adopted an existing batch; not paid twice]' : ''}, $${dollars(m.totalCents)} ledger / $${dollars(items.reduce((a, i) => a + i.sandboxCents, 0))} sandbox.`, { n, batchId });
    try {
      const body = invoiceBody(project, m, items, inspection);
      try {
        const inv = await pp.createInvoice(body, `inv-${project.salt}-m${n}`);
        batch.invoiceId = inv.href.split('/').pop();
      } catch (e) {
        if (!isDuplicateInvoice(e)) throw e;
        // the invoice for this milestone already exists: find it by number and carry on with it
        const found = await pp.searchInvoices({ invoice_number: body.detail.invoice_number });
        const id = found.items?.[0]?.id;
        if (!id) throw e;
        batch.invoiceId = id; batch.invoiceAdopted = true;
      }
    } catch (e) { batch.invoiceError = e.message; }
    await store.put(`BATCH#${batchId}`, batch);
    try { return await refreshBatch(batchId); } catch { return batch; }
  }

  function invoiceBody(project, m, items, inspection) {
    return {
      detail: {
        invoice_number: `ESC-${project.salt.toUpperCase()}-M${m.n}`, reference: inspection.id, currency_code: 'USD', invoice_date: iso().slice(0, 10),
        note: `Milestone ${m.n} (${m.title}) released on inspection ${inspection.id}, inspector ${inspection.inspector?.name || 'n/a'} ${inspection.inspector?.licence || ''}. ${inspection.verdict?.summary || ''}`.slice(0, 4000),
        payment_term: { term_type: 'NET_30' },
      },
      invoicer: { name: { business_name: 'Milestone Escrow (sandbox)' } },
      primary_recipients: [{ billing_info: { name: { business_name: project.title }, email_address: 'programme.sandbox@example.com' } }],
      items: items.map((it) => { const p = project.payees.find((x) => x.id === it.payeeId); return { name: `M${m.n} ${p.trade}: ${p.name}`.slice(0, 200), description: `Released on ${inspection.id}.${it.sandboxCents !== it.ledgerCents ? ` Sandbox amount (ledger $${dollars(it.ledgerCents)}).` : ''}`, quantity: '1', unit_amount: { currency_code: 'USD', value: dollars(it.sandboxCents) } }; }),
    };
  }

  // ---------- unhappy-path tools ----------
  async function cancelItem(batchId, payeeId) {
    const batch = await store.get(`BATCH#${batchId}`);
    const it = batch?.items.find((x) => x.payeeId === payeeId);
    if (!it) throw httpErr(404, 'NO_ITEM', 'No such payout item.');
    if (it.status !== 'UNCLAIMED') throw httpErr(409, 'NOT_UNCLAIMED', `Only UNCLAIMED items can be cancelled (this one is ${it.status}).`);
    try { await pp.cancelItem(it.itemId); } catch (e) { throw httpErr(502, e.name, e.message, { paypal: e.body }); }
    const b = await refreshBatch(batchId);
    await event('cancel', `Unclaimed payment to ${payeeId} cancelled; the money is back in escrow.`, { batchId });
    return b;
  }

  /**
   * Re-pay one payee after a failure / unclaimed payout. Never double-pays:
   * (1) refuses unless the previous payment is dead (cancelled/returned/failed) or is UNCLAIMED and is cancelled first;
   * (2) the new batch id is derived from the number of prior attempts, so a double-click reuses the same
   *     sender_batch_id and PayPal itself rejects the duplicate.
   */
  async function reissue({ n, payeeId, receiver }) {
    if (!isEmail(receiver)) throw httpErr(422, 'BAD_RECEIVER', 'That is not a valid email address.');
    const project = await ensureProject();
    const m = project.milestones.find((x) => x.n === Number(n));
    if (!m || m.status !== 'released') throw httpErr(409, 'NOT_RELEASED', 'Only a released milestone can be re-issued.');
    const batches = await store.list('BATCH#');
    const cur = latestItems(m, batches).find((i) => i.payeeId === payeeId);
    if (!cur) throw httpErr(404, 'NO_ITEM', 'No payment to re-issue.');
    if (cur.status === 'UNCLAIMED') await cancelItem(cur.batchId, payeeId);
    else if (!RETURNED.has(cur.status)) throw httpErr(409, 'NOT_RETRYABLE', `The payment is ${cur.status}; paying again now could pay twice.`);
    // verify from PayPal, not from our cache, that the old item is really dead
    const fresh = await store.get(`BATCH#${cur.batchId}`);
    const old = fresh.items.find((i) => i.payeeId === payeeId);
    if (!RETURNED.has(old.status)) throw httpErr(409, 'NOT_RETRYABLE', `The old payment is still ${old.status}; not paying again.`);

    const attempts = batches.filter((b) => b.milestone === m.n).reduce((a, b) => a + b.items.filter((i) => i.payeeId === payeeId).length, 0);
    const next = await mutate(async (p) => { p.payees.find((x) => x.id === payeeId).receiver = receiver; return store.putProject(p); });
    const mm = next.milestones.find((x) => x.n === m.n);
    const items = planRelease(next, mm, { reissuePayee: payeeId });
    const senderBatchId = `esc-${next.salt}-m${m.n}-${payeeId}-try${attempts + 1}`;
    const body = toPayoutBody(next, mm, items, senderBatchId);
    const senderItemId = `${next.id}-${next.salt}-m${m.n}-${payeeId}-try${attempts + 1}`;
    body.items[0].sender_item_id = senderItemId;
    let created;
    try { created = await pp.createPayout(body, senderBatchId); }
    catch (e) { throw httpErr(e.name === 'USER_BUSINESS_ERROR' ? 409 : 422, e.name === 'USER_BUSINESS_ERROR' ? 'DUPLICATE_REISSUE' : e.name, e.name === 'USER_BUSINESS_ERROR' ? 'This re-issue was already sent; PayPal refused to pay it twice.' : e.message, { paypal: e.body }); }
    const id = created.batch_header.payout_batch_id;
    const batch = { id, senderBatchId, requestId: senderBatchId, divisor: next.divisor, milestone: m.n, createdAt: iso(), status: created.batch_header.batch_status, reissue: true, items: items.map((it) => ({ ...it, senderItemId, status: 'PENDING', itemId: null, error: null })) };
    await store.put(`BATCH#${id}`, batch);
    await ledger.syncBatch(batch);
    await event('reissue', `Payment to ${payeeId} re-issued to a corrected address in batch ${id}.`, { n: m.n, batchId: id });
    return refreshBatch(id);
  }

  // ---------- webhooks ----------
  async function webhook({ headers, rawBody }) {
    let evt; try { evt = JSON.parse(rawBody); } catch { throw httpErr(400, 'BAD_JSON', 'not json'); }
    const webhookId = env.PAYPAL_WEBHOOK_ID;
    let verified = false, verifyNote = 'no webhook id configured';
    if (webhookId) {
      try {
        const v = await pp.verifyWebhook({
          auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
          transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'], webhook_id: webhookId, webhook_event: evt,
        });
        verified = v.verification_status === 'SUCCESS'; verifyNote = v.verification_status;
      } catch (e) { verified = false; verifyNote = 'verify call failed: ' + e.name; }
      if (!verified) {
        await event('webhook', `REJECTED ${evt.event_type || 'event'}: signature did not verify (${verifyNote}). Ignored.`, { type: evt.event_type, verified: false, rejected: true });
        throw httpErr(401, 'SIGNATURE_INVALID', 'Webhook signature could not be verified.');
      }
    }
    const type = evt.event_type || 'unknown'; const res = evt.resource || {};
    const batchId = res.batch_header?.payout_batch_id || res.payout_batch_id;
    let action = 'recorded';
    // Record first, acknowledge fast. The refresh is bounded to 2.5s: a slow PayPal read must never make the delivery time out
    // (the UI's own polling re-reads every open batch, so nothing depends on this nudge finishing).
    await store.put(`WHRAW#${iso()}#${randomUUID().slice(0, 4)}`, { at: iso(), headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k.startsWith('paypal-'))), rawBody, verified });
    if (type.startsWith('PAYMENT.PAYOUT') && batchId && (await store.get(`BATCH#${batchId}`))) {
      const timeout = new Promise((r) => setTimeout(() => r('timeout'), 2500));
      try { const r = await Promise.race([refreshBatch(batchId), timeout]); action = r === 'timeout' ? 'recorded; refresh left to the next poll' : 'batch re-read from PayPal and ledger synced'; } catch (e) { action = 'refresh failed: ' + e.message; }
    }
    if (type === 'INVOICING.INVOICE.PAID' && verified) {
      const invId = res.invoice?.id || res.id;
      const b = (await store.list('BATCH#')).find((x) => x.invoiceId === invId);
      if (b) { b.invoicePaid = true; await store.put(`BATCH#${b.id}`, b); action = 'invoice marked paid'; }
    }
    await event('webhook', `${type} (${verified ? 'signature verified' : 'unverified, no webhook id configured'}): ${action}`, { eventId: evt.id, type, verified });
    return { received: true, type, verified, action };
  }

  async function reset() {
    const p = await store.getProject();
    const run = (p?.run || 0) + 1;
    await store.wipe();
    const fresh = await store.putProject(freshProject(env, run), { create: true });
    await ledger.fund(fresh.fundedCents);
    await applyReference(fresh);
    return view();
  }

  return { view, inspect, refreshBatch, refreshOpen, reconcile, cancelItem, reissue, webhook, reset, ensureProject, release, ledger };
}
