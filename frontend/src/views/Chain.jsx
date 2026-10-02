import React, { useEffect } from 'react';
import Icon from '../Icon.jsx';
import { usd, usd2, sandboxOf, STATUS, cellStatus, diagnostic } from '../util.js';

const stateText = (m) => m.state === 'released' ? (m.rollup && m.rollup.needsAttention ? 'Released, needs attention' : m.reference ? 'Released (reference run)' : 'Released')
  : m.state === 'awaiting' ? 'Awaiting inspection' : m.state === 'held' ? 'Held: not proven' : m.state === 'releasing' ? 'Releasing' : 'Not yet due';
const Status = ({ k }) => <span className="lbl"><Icon name={STATUS[k].icon} />{STATUS[k].label}</span>;

export default function Chain({ view, flash, onInspect }) {
  const focus = null;
  const { milestones: ms, escrow, project } = view;
  const d = diagnostic(view);
  const subOwed = ms.filter((m) => m.state !== 'released').reduce((a, m) => a + m.splits.filter((s) => s.payee !== 'gc').reduce((x, s) => x + s.cents, 0), 0);
  const tiles = [
    ['Total escrowed', usd(escrow.fundedCents), 'the grant', ''],
    ['Released', usd(escrow.committedCents), `${usd(escrow.deliveredCents)} landed`, 't-ok'],
    ['Pending inspection', usd(escrow.remainingCents), `${ms.filter((m) => m.state !== 'released').length} milestones left`, 't-warn'],
    ['Owed downstream', usd(subOwed), 'to subcontractors', ''],
  ];
  const all = ms.flatMap((m) => m.state === 'released' && m.items.length ? m.items.map((i) => cellStatus(m, i)) : m.splits.map(() => cellStatus(m, null)));
  const count = (k) => all.filter((x) => x === k).length;
  const gc = project.payees.filter((p) => p.tier === 1);
  const subs = project.payees.filter((p) => p.tier === 2);
  const fm = flash && ms.find((m) => m.n === flash.n);
  useEffect(() => { if (flash) document.querySelector('.release')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }, [flash]);

  return (<>
    <section className="panel" aria-labelledby="diag">
      <div className="pHead">
        <div><h1 id="diag">{d.head}</h1><p>{d.sub}</p></div>
      </div>
      <div className="tiles">{tiles.map(([k, v, s, c]) => <div className={'tile ' + c} key={k}><h3>{k}</h3><b>{v}</b><i>{s}</i></div>)}</div>
    </section>

    {fm && <div className="release" role="status"><svg width="34" height="34" viewBox="0 0 34 34" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="17" cy="17" r="14" /><path d="M10.5 17.5l4.5 4.5 8.5-9" /></svg>
        <div><b>Milestone {fm.n} released.</b> {fm.splits.length} payments left escrow in one PayPal batch{flash.batchId ? ` (${flash.batchId})` : ''}: {usd(fm.totalCents)} to the contractor and {fm.splits.length - 1} subcontractor{fm.splits.length - 1 === 1 ? '' : 's'}.</div></div>}
    <section className="gridWrap grid-only" aria-label="Payment chain: parties by milestone">
      <div className="gscroll"><div className={'grid' + (flash ? ' flowing' : '')} style={{ '--cols': ms.length }} role="table" aria-label="Payments by party and milestone">
        <div className="gh corner">Party</div>
        {ms.map((m) => {
          const r = m.rollup;
          return (<div key={m.n} className={'gh mh ' + m.state + (focus === m.n ? ' focus' : '')}>
            <b>{m.n}. {m.title}</b>
            <span className="st">{stateText(m)}</span>
            {r && !r.settled && <><span className="st">{r.total - r.inflight} of {r.total} settled</span>
              <div className="prog amber" role="progressbar" aria-label={`Milestone ${m.n} payments settled`} aria-valuemin="0" aria-valuemax={r.total} aria-valuenow={r.total - r.inflight}><i style={{ width: `${((r.total - r.inflight) / r.total) * 100}%` }} /></div></>}
            {r && r.settled && <span className="st">{r.delivered} of {r.total} landed</span>}
            {(m.state === 'awaiting' || m.state === 'held') && <button className="btn sm" onClick={() => onInspect(m.n)}>Release milestone {m.n}</button>}
          </div>);
        })}
        <div className="gg"><i className="d forest" aria-hidden="true" />General contractor <em>{gc.length}</em></div>
        {gc.map((p) => <Row key={p.id} p={p} ms={ms} divisor={project.divisor} flash={flash} focus={focus} idx={0} />)}
        <div className="gg"><i className="d" aria-hidden="true" />Subcontractors, paid in the same batch <em>{subs.length}</em></div>
        {subs.map((p, i) => <Row key={p.id} p={p} ms={ms} divisor={project.divisor} flash={flash} focus={focus} idx={i + 1} sub />)}
      </div></div>
    </section>

    <section className="stack" aria-label="Payments by milestone">
      {ms.map((m) => (
        <article key={m.n} className="mcard">
          <header><b>{m.n}. {m.title}</b><span className="muted">{usd(m.totalCents)} · {stateText(m)}</span>
            {(m.state === 'awaiting' || m.state === 'held') && <button className="btn sm" onClick={() => onInspect(m.n)}>Release milestone {m.n}</button>}</header>
          {m.splits.map((s) => {
            const p = project.payees.find((x) => x.id === s.payee); const item = m.items.find((i) => i.payeeId === s.payee); const k = cellStatus(m, item);
            return (<div key={s.payee} className={'mrow ' + (p.tier === 2 ? 'sub ' : '') + k}>
              <div className="who2"><b>{p.name}</b><small>{p.trade}</small></div><div className="amt">{usd(s.cents)}</div>
              <span className={'lbl lg tone-' + STATUS[k].tone} style={{ justifySelf: 'start' }}><Icon name={STATUS[k].icon} size={13} />{STATUS[k].label}</span></div>);
          })}
        </article>))}
    </section>

    <footer className="bar" aria-label="Payment status summary">
      {[['landed', 'landed'], ['moving', 'in motion'], ['unclaimed', 'sent, unclaimed'], ['failed', 'failed'], ['blocked', 'blocked'], ['waiting', 'awaiting inspection']].filter(([k]) => count(k) > 0).map(([k, l]) =>
        <span key={k} className="bi"><Icon name={STATUS[k].icon} size={13} />{count(k)} {l}</span>)}
      <span className="grow" /><span className="bi muted note">{view.ledger.trial.balanced && view.ledger.trial.identityOk ? 'Ledger balanced' : 'Ledger out of balance'}</span>
    </footer>
  </>);
}

function Row({ p, ms, divisor, flash, focus, idx, sub }) {
  return (<>
    <div className={'gp' + (sub ? ' sub' : '')} role="rowheader">
      {sub && <span className="elbow" aria-hidden="true" />}
      <span className="av" aria-hidden="true">{p.name.split(/[ &]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('')}</span>
      <span><b>{p.name}</b><small>{p.trade}</small></span>
    </div>
    {ms.map((m) => {
      const s = m.splits.find((x) => x.payee === p.id);
      if (!s) return <div key={m.n} className={'cell empty' + (focus === m.n ? ' focus' : '')} role="cell" aria-label={`${p.name}: nothing due in milestone ${m.n}`} />;
      const item = m.items.find((i) => i.payeeId === p.id);
      const k = cellStatus(m, item);
      const cascading = flash && flash.n === m.n;
      return (
        <div key={m.n} role="cell" className={`cell tone-${STATUS[k].tone} s-${k}${cascading ? ' cascade' : ''}${focus === m.n ? ' focus' : ''}`} style={cascading ? { animationDelay: `${idx * 110}ms` } : undefined}>
          <b>{usd(s.cents)}</b>
          {(item ? item.sandboxCents : sandboxOf(s.cents, divisor)) !== s.cents && <span className="sbx">sent as {usd2(item ? item.sandboxCents : sandboxOf(s.cents, divisor))}</span>}
          <Status k={k} />
          {item?.unclaimed && <span className="sub2">{item.unclaimed.daysUntilReturned} days left to claim</span>}
          {item?.error && !item.unclaimed && <span className="sub2">{item.error.name}</span>}
          {cascading && <span className="rise" aria-hidden="true">+{usd(s.cents)}</span>}
        </div>
      );
    })}
  </>);
}

export function Chart({ ms }) {
  const W = 1100, H = 170, L = 56, R = 20, T = 14, B = 34;
  const total = ms.reduce((a, m) => a + m.totalCents, 0);
  const x = (i) => L + ((W - L - R) / ms.length) * i;
  const y = (c) => T + (H - T - B) * (1 - c / total);
  let cum = 0, relCum = 0; const sched = [0], rel = [0];
  ms.forEach((m) => { cum += m.totalCents; sched.push(cum); if (m.state === 'released') relCum += m.totalCents; rel.push(relCum); });
  const step = (arr) => arr.map((c, i) => i === 0 ? `M${x(0)},${y(0)}` : `L${x(i)},${y(arr[i - 1])} L${x(i)},${y(c)}`).join(' ');
  const band = step(sched) + ` L${x(ms.length)},${y(0)} L${x(0)},${y(0)} Z`;
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  return (<div className="chartWrap">
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Scheduled release against actual release by milestone. ${relCum ? usd(relCum) : '$0'} of ${usd(total)} released so far.`}>
      {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(total * t)} y2={y(total * t)} className="gl" /><text x={L - 8} y={y(total * t) + 4} className="tk" textAnchor="end">${Math.round((total * t) / 100000)}k</text></g>)}
      <path d={band} className="band" /><path d={step(sched)} className="schedLine" /><path d={step(rel)} className="relLine" />
      {ms.map((m, i) => <text key={m.n} x={(x(i) + x(i + 1)) / 2} y={H - 10} className="tk" textAnchor="middle">{m.n} {m.title.split(' ')[0]}</text>)}
    </svg>
    <div className="clegend"><span><i className="sw band" />Scheduled release, cumulative</span><span><i className="sw line" />Actually released</span></div>
  </div>);
}
