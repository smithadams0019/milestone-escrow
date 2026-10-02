// Double-entry ledger. Every movement is one entry with two balanced lines (DR total == CR total).
//
//   fund      DR escrow:held        CR grant:source        grant arrives
//   submit    DR transit:<payee>    CR escrow:held         released to PayPal in a payout batch
//   land      DR paid:<payee>       CR transit:<payee>     PayPal item SUCCESS
//   return    DR escrow:held        CR transit:<payee>     item FAILED / RETURNED / cancelled: money is back
//   reverse   DR escrow:held        CR paid:<payee>        a landed payment was refunded or reversed
//
// Identity that must always hold:  held + sum(transit) + sum(paid) == funded.
// Entries are keyed, and written create-only, so replaying a sync can never post a movement twice.

const DEBIT_NORMAL = (a) => !a.startsWith('grant:') ;

export const RETURNED = new Set(['FAILED', 'RETURNED', 'REFUNDED', 'REVERSED', 'CANCELED', 'DENIED', 'BLOCKED']);
export const IN_TRANSIT = new Set(['PENDING', 'PROCESSING', 'UNCLAIMED', 'ONHOLD']);
export function desiredPosition(status) {
  if (status === 'SUCCESS') return 'paid';
  if (IN_TRANSIT.has(status)) return 'transit';
  if (RETURNED.has(status)) return 'returned';
  return null; // unknown status: reported as drift, never guessed
}

export function makeLedger(store, { now = () => new Date() } = {}) {
  const entry = (key, kind, ref, lines, memo, at) => ({ key, at: at || now().toISOString(), kind, ref, lines, memo });
  const balanced = (e) => e.lines.filter((l) => l.side === 'DR').reduce((a, l) => a + l.cents, 0) === e.lines.filter((l) => l.side === 'CR').reduce((a, l) => a + l.cents, 0);

  async function post(e) {
    if (!balanced(e)) throw new Error('refusing to post an unbalanced entry ' + e.key);
    return store.putIfAbsent('LED#' + e.key, e);
  }
  const ORDER = { fund: 0, submit: 1, land: 2, return: 3, reverse: 3 };
  // chronological; within the same instant a movement is always replayed in its causal order (submit before land)
  async function all() { return (await store.list('LED#', { limit: 2000 })).sort((a, b) => a.at.localeCompare(b.at) || ORDER[a.kind] - ORDER[b.kind] || a.key.localeCompare(b.key)); }

  function positions(entries) {
    const pos = new Map();
    for (const e of entries) {
      const sid = e.ref?.senderItemId; if (!sid) continue;
      pos.set(sid, e.kind === 'submit' ? 'transit' : e.kind === 'land' ? 'paid' : 'returned');
    }
    return pos;
  }

  async function fund(cents, at) {
    return post(entry('fund', 'fund', {}, [{ account: 'escrow:held', side: 'DR', cents }, { account: 'grant:source', side: 'CR', cents }], 'Grant funds received into escrow', at));
  }

  /** Bring the ledger in line with the item statuses of a stored batch. Idempotent. Returns entries posted. */
  async function syncBatch(batch) {
    const entries = await all(); const pos = positions(entries); const posted = [];
    for (const it of batch.items) {
      const sid = it.senderItemId; const cur = pos.get(sid) || 'none'; const want = desiredPosition(it.status);
      const ref = { batchId: batch.id, senderItemId: sid, payeeId: it.payeeId, milestone: batch.milestone };
      const L = (acct, side) => ({ account: acct, side, cents: it.ledgerCents });
      const steps = [];
      if (cur === 'none') steps.push(['submit', `submit:${sid}`, [L('transit:' + it.payeeId, 'DR'), L('escrow:held', 'CR')], `Released to ${it.payeeId} in batch ${batch.id}`, batch.createdAt]);
      let at = cur === 'none' ? 'transit' : cur;
      if (want === 'paid' && at === 'transit') { steps.push(['land', `land:${sid}`, [L('paid:' + it.payeeId, 'DR'), L('transit:' + it.payeeId, 'CR')], `PayPal confirmed delivery to ${it.payeeId}`, it.processedAt]); at = 'paid'; }
      if (want === 'returned' && at === 'transit') { steps.push(['return', `return:${sid}`, [L('escrow:held', 'DR'), L('transit:' + it.payeeId, 'CR')], `Payment to ${it.payeeId} ${it.status}: money returned to escrow`, it.processedAt]); at = 'returned'; }
      if (want === 'returned' && at === 'paid') { steps.push(['reverse', `reverse:${sid}`, [L('escrow:held', 'DR'), L('paid:' + it.payeeId, 'CR')], `Landed payment to ${it.payeeId} ${it.status}`, it.processedAt]); at = 'returned'; }
      for (const [kind, key, lines, memo, when] of steps) {
        if (await post(entry(key, kind, ref, lines, memo, when || undefined))) posted.push(key);
      }
    }
    return posted;
  }

  async function trial() {
    const entries = await all(); const bal = {};
    for (const e of entries) for (const l of e.lines) bal[l.account] = (bal[l.account] || 0) + (l.side === 'DR' ? l.cents : -l.cents);
    // report every account as a positive number in its normal direction
    const accounts = Object.fromEntries(Object.entries(bal).map(([a, v]) => [a, DEBIT_NORMAL(a) ? v : -v]));
    const sum = (prefix) => Object.entries(accounts).filter(([a]) => a.startsWith(prefix)).reduce((x, [, v]) => x + v, 0);
    const dr = entries.flatMap((e) => e.lines).filter((l) => l.side === 'DR').reduce((a, l) => a + l.cents, 0);
    const cr = entries.flatMap((e) => e.lines).filter((l) => l.side === 'CR').reduce((a, l) => a + l.cents, 0);
    const funded = accounts['grant:source'] || 0;
    const held = accounts['escrow:held'] || 0, transit = sum('transit:'), paid = sum('paid:');
    return { entries: entries.length, debits: dr, credits: cr, balanced: dr === cr, accounts, fundedCents: funded, heldCents: held, transitCents: transit, paidCents: paid, identityOk: held + transit + paid === funded };
  }

  /**
   * Compare the ledger with what PayPal says RIGHT NOW. `live` is a Map batchId -> GET /payouts/{id} response.
   * Anything that disagrees is reported as drift; nothing is auto-corrected here.
   */
  async function reconcile(batches, live, divisor) {
    const entries = await all(); const pos = positions(entries); const drift = []; const checks = [];
    const t = await trial();
    checks.push({ name: 'Debits equal credits', ok: t.balanced });
    checks.push({ name: 'held + in transit + paid equals funded', ok: t.identityOk });
    if (!t.balanced) drift.push({ check: 'trial-balance', expected: t.debits, actual: t.credits });
    if (!t.identityOk) drift.push({ check: 'escrow-identity', expected: t.fundedCents, actual: t.heldCents + t.transitCents + t.paidCents });
    let itemChecks = 0;
    for (const b of batches) {
      const lv = live.get(b.id);
      if (!lv) { drift.push({ check: 'batch-missing-at-paypal', batchId: b.id }); continue; }
      const liveItems = lv.items || [];
      const sumLive = liveItems.reduce((a, i) => a + Math.round(Number(i.payout_item.amount.value) * 100), 0);
      const hdr = Math.round(Number(lv.batch_header?.amount?.value ?? 0) * 100);
      itemChecks++;
      if (hdr && hdr !== sumLive) drift.push({ check: 'paypal-batch-total-vs-items', batchId: b.id, expected: hdr, actual: sumLive });
      const liveBy = new Map(liveItems.map((i) => [i.payout_item.sender_item_id, i]));
      for (const it of b.items) {
        itemChecks++;
        const li = liveBy.get(it.senderItemId);
        if (!li) { drift.push({ check: 'ledger-item-not-at-paypal', batchId: b.id, payeeId: it.payeeId }); continue; }
        const liveCents = Math.round(Number(li.payout_item.amount.value) * 100);
        if (liveCents !== Math.round(it.ledgerCents / (b.divisor || divisor))) drift.push({ check: 'amount', batchId: b.id, payeeId: it.payeeId, expected: Math.round(it.ledgerCents / (b.divisor || divisor)), actual: liveCents });
        const want = desiredPosition(li.transaction_status);
        if (want === null) { drift.push({ check: 'unknown-paypal-status', batchId: b.id, payeeId: it.payeeId, actual: li.transaction_status }); continue; }
        const have = pos.get(it.senderItemId) || 'none';
        if (have !== want) drift.push({ check: 'ledger-position-vs-paypal', batchId: b.id, payeeId: it.payeeId, expected: want, actual: have, paypalStatus: li.transaction_status });
      }
      const mine = new Set(b.items.map((i) => i.senderItemId));
      for (const li of liveItems) if (!mine.has(li.payout_item.sender_item_id)) drift.push({ check: 'paypal-item-not-in-ledger', batchId: b.id, senderItemId: li.payout_item.sender_item_id });
    }
    checks.push({ name: `${itemChecks} batch and item comparisons against live PayPal`, ok: drift.every((d) => !['amount', 'ledger-position-vs-paypal', 'ledger-item-not-at-paypal', 'paypal-item-not-in-ledger', 'unknown-paypal-status', 'paypal-batch-total-vs-items', 'batch-missing-at-paypal'].includes(d.check)) });
    return { at: now().toISOString(), ok: drift.length === 0, checks, drift, trial: t };
  }

  return { fund, syncBatch, trial, reconcile, all, post, positions };
}
