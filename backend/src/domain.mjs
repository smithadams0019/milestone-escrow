import { randomBytes } from 'node:crypto';
import { MILESTONES, PAYEES, PROJECT_ID, SANDBOX_DIVISOR, TOTAL_CENTS } from './seed.mjs';

// Lowest of the three per-item caps PayPal documents (FAQ: 20,000; fee table: 60,000 / 20,000).
export const ITEM_CAP_CENTS = 20000 * 100;
export const BATCH_ITEM_LIMIT = 15000; // live spec: Payouts 1.9, maxItems 15000
export const RELEASE_MIN_CONFIDENCE = 0.75;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (s) => typeof s === 'string' && s.length <= 127 && EMAIL_RE.test(s);

export const dollars = (cents) => (cents / 100).toFixed(2);
export const sandboxCents = (ledgerCents) => Math.round(ledgerCents / SANDBOX_DIVISOR);

export function defaultRecipients(env = {}) {
  let overrides = {};
  try { overrides = JSON.parse(env.RECIPIENTS_JSON || '{}'); } catch { /* ignore */ }
  const out = {};
  for (const p of PAYEES) out[p.id] = overrides[p.id] || `${p.id}.escrow-demo@example.com`;
  return out;
}

export function freshProject(env = {}, run = 1) {
  const recipients = defaultRecipients(env);
  return {
    id: PROJECT_ID,
    run,
    salt: env.SALT || randomBytes(3).toString('hex'), // makes every run's PayPal ids unique, even if a database is wiped
    version: 0,
    title: 'Whitfield family home rebuild',
    place: 'Lumberton, North Carolina',
    fundedCents: TOTAL_CENTS,
    divisor: SANDBOX_DIVISOR,
    payees: PAYEES.map((p) => ({ ...p, receiver: recipients[p.id] })),
    milestones: MILESTONES.map((m) => ({
      n: m.n, key: m.key, title: m.title, inspection: m.inspection,
      requirements: m.requirements,
      splits: m.splits.map(([payee, cents]) => ({ payee, cents })),
      totalCents: m.splits.reduce((a, [, c]) => a + c, 0),
      status: 'pending', // pending | releasing | released
      verdict: null, inspectionId: null, batchId: null, invoiceId: null, releasedAt: null,
    })),
  };
}

export function milestoneState(project, m) {
  const prev = project.milestones.find((x) => x.n === m.n - 1);
  if (m.status === 'released') return 'released';
  if (m.status === 'releasing') return 'releasing';
  if (prev && prev.status !== 'released') return 'locked';
  return m.verdict && m.verdict.releaseBlocked ? 'held' : 'awaiting';
}

/** Build and validate the one-batch payout for a milestone. Throws Error with .code on a bad plan. */
export function planRelease(project, m, { reissuePayee } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const splits = reissuePayee ? m.splits.filter((s) => s.payee === reissuePayee) : m.splits;
  if (!splits.length) throw fail('NO_SPLITS', 'milestone has nothing to pay');
  if (splits.length > BATCH_ITEM_LIMIT) throw fail('BATCH_TOO_LARGE', 'over 15,000 items');
  if (!reissuePayee) {
    const sum = splits.reduce((a, s) => a + s.cents, 0);
    if (sum !== m.totalCents) throw fail('SPLIT_MISMATCH', `splits sum ${sum} != milestone ${m.totalCents}`);
  }
  const seen = new Set();
  const items = splits.map((s) => {
    const payee = project.payees.find((p) => p.id === s.payee);
    if (!payee) throw fail('UNKNOWN_PAYEE', `unknown payee ${s.payee}`);
    if (seen.has(payee.id)) throw fail('DUPLICATE_PAYEE', `duplicate payee ${payee.id}`);
    seen.add(payee.id);
    if (!isEmail(payee.receiver)) throw fail('BAD_RECEIVER', `${payee.name}: ${payee.receiver} is not a valid email`);
    const sc = sandboxCents(s.cents);
    if (sc < 1) throw fail('AMOUNT_TOO_SMALL', `${payee.name}: amount rounds to zero`);
    if (s.cents > ITEM_CAP_CENTS) throw fail('ITEM_CAP', `${payee.name}: over the per-item cap`);
    return { payeeId: payee.id, receiver: payee.receiver, ledgerCents: s.cents, sandboxCents: sc };
  });
  return items;
}

export function committedCents(batches) {
  // Money that has left (or is on its way out of) escrow. Failed/returned/cancelled items do not count.
  const dead = new Set(['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'CANCELED', 'DENIED']);
  let c = 0;
  for (const b of batches) for (const it of b.items) if (!dead.has(it.status)) c += it.ledgerCents;
  return c;
}

export function toPayoutBody(project, m, items, senderBatchId) {
  return {
    sender_batch_header: {
      sender_batch_id: senderBatchId,
      email_subject: `Milestone ${m.n} released: ${m.title}`,
      email_message: `An inspector signed off "${m.inspection}" on the ${project.title}. This payment was released automatically from escrow.`,
    },
    items: items.map((it) => ({
      recipient_type: 'EMAIL',
      receiver: it.receiver,
      amount: { currency: 'USD', value: dollars(it.sandboxCents) },
      note: `M${m.n} ${m.title}`,
      sender_item_id: `${project.id}-${project.salt}-m${m.n}-${it.payeeId}`,
    })),
  };
}

/** Item-level truth. Batch status alone is NOT delivery: a batch reads SUCCESS with every item UNCLAIMED. */
export function rollup(items) {
  const n = (s) => items.filter((i) => i.status === s).length;
  const delivered = n('SUCCESS');
  const unclaimed = n('UNCLAIMED');
  const failed = items.filter((i) => ['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED', 'CANCELED', 'DENIED', 'ONHOLD'].includes(i.status)).length;
  const inflight = items.length - delivered - unclaimed - failed;
  return {
    total: items.length, delivered, unclaimed, failed, inflight,
    settled: inflight === 0,
    allDelivered: delivered === items.length,
    needsAttention: unclaimed + failed > 0,
  };
}

export function mapItem(prev, ppItem) {
  const err = ppItem.errors || null;
  return {
    ...prev,
    itemId: ppItem.payout_item_id || prev.itemId,
    status: ppItem.transaction_status || prev.status,
    transactionId: ppItem.transaction_id || prev.transactionId || null,
    error: err ? { name: err.name, message: err.message } : null,
    processedAt: ppItem.time_processed || prev.processedAt || null,
  };
}

export const TERMINAL_BATCH = new Set(['SUCCESS', 'DENIED', 'CANCELED']);
