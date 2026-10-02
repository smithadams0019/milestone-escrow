export const usd = (cents, d = 0) => '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
export const usd2 = (cents) => usd(cents, 2);
export const sandboxOf = (cents, divisor) => Math.round(cents / divisor);

// tone: ok | warn | bad | idle. Colour is never the only signal: every status also has a word and an icon.
export const STATUS = {
  landed:    { label: 'Landed', tone: 'ok', icon: 'check' },
  moving:    { label: 'In motion', tone: 'warn', icon: 'clock' },
  unclaimed: { label: 'Sent, unclaimed', tone: 'warn', icon: 'mail' },
  failed:    { label: 'Failed', tone: 'bad', icon: 'alert' },
  waiting:   { label: 'Awaiting inspection', tone: 'idle', icon: 'hourglass' },
  blocked:   { label: 'Blocked', tone: 'bad', icon: 'stop' },
  locked:    { label: 'Not yet due', tone: 'idle', icon: 'dash' },
};

export function cellStatus(m, item) {
  if (item) {
    const s = item.status;
    if (s === 'SUCCESS') return 'landed';
    if (s === 'UNCLAIMED') return 'unclaimed';
    if (s === 'PENDING' || s === 'PROCESSING') return 'moving';
    return 'failed';
  }
  if (m.state === 'releasing') return 'moving';
  if (m.state === 'held') return 'blocked';
  if (m.state === 'awaiting') return 'waiting';
  return 'locked';
}

export function diagnostic(view) {
  const next = view.milestones.find((m) => m.state === 'awaiting' || m.state === 'held');
  if (!next) return { head: 'Every milestone has been released.', sub: 'The whole chain has been paid. Nothing is waiting on an inspector.' };
  const subs = next.splits.filter((s) => s.payee !== 'gc');
  const subCents = subs.reduce((a, s) => a + s.cents, 0);
  const held = next.state === 'held';
  return {
    head: held ? `Where the money sits across ${view.milestones.length} milestones.` : `${usd(next.totalCents)} is held for the milestone ${next.n} inspection.`,
    sub: subs.length
      ? `${usd(subCents)} of it is owed to ${subs.length} subcontractor${subs.length > 1 ? 's' : ''}. They are waiting on an inspector's signature, not on the contractor.`
      : `It is the contractor's final retainage. It releases when the certificate of occupancy is issued.`,
  };
}

export const when = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
