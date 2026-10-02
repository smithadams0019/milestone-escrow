import React, { useState } from 'react';
import { api } from '../api.js';
import Icon from '../Icon.jsx';
import { Trace } from '../InspectDrawer.jsx';
import { Chart } from './Chain.jsx';
import { usd, usd2, when, STATUS, cellStatus } from '../util.js';

const ACCT = (a, nm) => a.replace('escrow:held', 'Escrow held').replace('grant:source', 'Grant').replace(/^transit:(.+)/, (_, id) => 'In transit to ' + (nm[id] || id)).replace(/^paid:(.+)/, (_, id) => 'Paid to ' + (nm[id] || id));

export default function Ledger({ view, reload }) {
  const [busy, setBusy] = useState(null); const [msg, setMsg] = useState(null); const [fix, setFix] = useState({});
  const payee = (id) => view.project.payees.find((p) => p.id === id);
  const run = async (key, fn) => { setBusy(key); setMsg(null); try { await fn(); await reload(); } catch (e) { setMsg(e.message); } setBusy(null); };
  const batches = [...view.batches].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const { trial, recon, entries } = view.ledger;
  const nm = Object.fromEntries(view.project.payees.map((p) => [p.id, p.name.split(' ').slice(0, 2).join(' ')]));
  const scaled = view.batches.some((b) => b.items.some((i) => i.sandboxCents !== i.ledgerCents));
  return (<>
    <section className="panel" aria-labelledby="led">
      <div className="pHead"><div><h1 id="led">Double-entry ledger</h1><p>Every movement is two balanced entries. Held, in transit and paid always add up to the grant.</p></div>
        <button className="btn" disabled={busy === 'rec'} onClick={() => run('rec', api.reconcile)}>{busy === 'rec' ? 'Comparing with PayPal' : 'Reconcile with PayPal'}</button></div>
      <div className="kv">
        <div><h3>Funded</h3><b>{usd2(trial.fundedCents)}</b></div><div><h3>Held in escrow</h3><b>{usd2(trial.heldCents)}</b></div>
        <div><h3>In transit or unclaimed</h3><b>{usd2(trial.transitCents)}</b></div><div><h3>Paid</h3><b>{usd2(trial.paidCents)}</b></div>
      </div>
      <div className="recon">
        <p><span className={'tag ' + (trial.balanced && trial.identityOk ? 'tone-ok' : 'tone-bad')}><Icon name={trial.balanced && trial.identityOk ? 'check' : 'alert'} size={12} />&nbsp;{trial.balanced && trial.identityOk ? 'Balanced' : 'Out of balance'}</span>
          &nbsp; {trial.entries} entries · debits {usd2(trial.debits)} · credits {usd2(trial.credits)}</p>
        {!recon && <p className="muted" style={{ marginTop: 8 }}>Not reconciled yet. Use Reconcile with PayPal to compare every batch and item with PayPal's live state.</p>}
        {recon && <>
          <p style={{ marginTop: 8 }}><span className={'tag ' + (recon.ok ? 'tone-ok' : 'tone-bad')}><Icon name={recon.ok ? 'check' : 'alert'} size={12} />&nbsp;{recon.ok ? 'Matches PayPal' : `${recon.drift.length} difference${recon.drift.length > 1 ? 's' : ''} found`}</span> &nbsp;<span className="muted">checked {when(recon.at)}</span></p>
          <ul>{recon.checks.map((c) => <li key={c.name}><Icon name={c.ok ? 'check' : 'alert'} size={14} />{c.name}</li>)}</ul>
          {recon.drift.map((d, i) => <div className="banner red" key={i}><b>{d.check}</b> {d.batchId ? `batch ${d.batchId} ` : ''}{d.payeeId ? `payee ${d.payeeId} ` : ''}expected {String(d.expected ?? '')}, PayPal shows {String(d.actual ?? '')}{d.paypalStatus ? ` (${d.paypalStatus})` : ''}</div>)}
        </>}
      </div>
      <div className="tscroll" tabIndex={0} role="region" aria-label="Scrollable table"><table><caption className="sr">Latest ledger entries</caption><thead><tr><th>When</th><th>Movement</th><th>Debit</th><th>Credit</th><th className="r">Amount</th></tr></thead>
        <tbody>{entries.slice(0, 14).map((e) => <tr key={e.key}><td className="muted">{when(e.at)}</td><td>{e.memo.replace(/to (\w+) in batch/, (_, id) => `to ${nm[id] || id} in batch`)}</td><td>{ACCT(e.lines.find((l) => l.side === 'DR').account, nm)}</td><td>{ACCT(e.lines.find((l) => l.side === 'CR').account, nm)}</td><td className="r num">{usd2(e.lines[0].cents)}</td></tr>)}</tbody></table></div>
    </section>

    <section className="panel chartPanel" aria-label="Release schedule"><Chart ms={view.milestones} /></section>

    <section className="panel" aria-labelledby="bat">
      <div className="pHead"><div><h2 className="h2" id="bat">PayPal batches, item by item</h2><p>A batch can read SUCCESS while every item inside it is unclaimed. A payment counts as landed only when its own item says SUCCESS.</p></div></div>
      {msg && <div className="banner red" role="alert" style={{ margin: '0 24px 16px' }}>{msg}</div>}
      {!batches.length && <div className="empty-state"><b>No batches yet</b>Release milestone 2 from The chain tab to create the first one.</div>}
      {batches.map((b) => (
        <div className="batch" key={b.id}>
          <div className="bHead"><b>Milestone {b.milestone}</b><code>{b.id}</code>
            <span className={'tag ' + (b.status === 'SUCCESS' ? 'tone-ok' : 'tone-warn')}>batch {b.status}</span>
            {b.invoiceId && <span className="tag tone-idle">invoice {b.invoiceId}</span>}
            {b.invoiceError && <span className="tag tone-warn">invoice not created</span>}
            {b.reissue && <span className="tag tone-idle">re-issue</span>}{b.adopted && <span className="tag tone-idle">adopted existing batch</span>}
            <span className="muted">{when(b.createdAt)}{b.fees != null ? ` · PayPal fees $${b.fees}` : ''}</span></div>
          <div className="tscroll" tabIndex={0} role="region" aria-label="Scrollable table"><table><thead><tr><th>Payee</th><th>Receiver</th><th className="r">Ledger</th>{scaled && <th className="r">Sent</th>}<th>Item status</th><th>Action</th></tr></thead>
            <tbody>{b.items.map((it) => {
              const st = cellStatus({ state: 'released' }, it); const key = b.id + it.payeeId;
              const age = it.status === 'UNCLAIMED' && it.processedAt ? Math.floor((Date.now() - Date.parse(it.processedAt)) / 86400000) : null;
              return (<tr key={it.payeeId}>
                <td>{payee(it.payeeId)?.name}</td><td><code>{it.receiver}</code></td>
                <td className="r num">{usd2(it.ledgerCents)}</td>{scaled && <td className="r num">{usd2(it.sandboxCents)}</td>}
                <td><span className={'tag tone-' + STATUS[st].tone}><Icon name={STATUS[st].icon} size={12} />&nbsp;{it.status}</span>{it.error && <small className="err">{it.error.name}</small>}{age != null && <small className="err">{age < 1 ? 'Unclaimed under a day' : `Unclaimed ${age} days`}; returns at 30 days</small>}</td>
                <td>{it.status === 'UNCLAIMED' ? <span className="acts">
                  <button className="btn sm" disabled={busy === key} onClick={() => run(key, () => api.cancel(b.id, it.payeeId))}>Cancel payment</button>
                  <input aria-label={`Corrected email for ${payee(it.payeeId)?.name}`} placeholder="corrected email" value={fix[key] || ''} onChange={(e) => setFix({ ...fix, [key]: e.target.value })} />
                  <button className="btn sm" disabled={busy === key || !fix[key]} onClick={() => run(key, () => api.reissue({ n: b.milestone, payeeId: it.payeeId, receiver: fix[key] }))}>Pay corrected address</button></span>
                  : <span className="muted">None needed</span>}</td>
              </tr>);
            })}</tbody></table></div>
        </div>))}
    </section>

    <section className="panel" aria-labelledby="ins">
      <div className="pHead"><div><h2 className="h2" id="ins">Inspections and agent decisions</h2><p>Each decision keeps the full tool trace, including any release the rules check refused.</p></div></div>
      {!view.inspections.length && <div className="empty-state"><b>No inspections reviewed yet</b>Release a milestone to see the agent's tool calls here.</div>}
      {view.inspections.map((i) => (<div className="batch" key={i.id}>
        <div className="bHead"><b>Milestone {i.n}</b><code>{i.id}</code><span className={'tag ' + (i.agent?.outcome === 'withheld' ? 'tone-bad' : 'tone-ok')}>{i.agent?.outcome === 'withheld' ? 'withheld' : 'released'}</span><span className="muted">{when(i.at)} · {i.inspector?.name || 'no inspector'} {i.inspector?.licence || ''}</span></div>
        <p className="muted">{i.verdict?.summary}</p>
        {i.verdict?.releaseBlocked && i.verdict.reasons?.length > 0 && <p className="err">{i.verdict.reasons.join(' ')}</p>}
        <Trace agent={i.agent} />
      </div>))}
    </section>

    <section className="panel" aria-labelledby="act">
      <div className="pHead"><div><h2 className="h2" id="act">Activity</h2><p>What the household sees: every release, hold, return and webhook, newest first.</p></div></div>
      {!view.events.length && <div className="empty-state"><b>Nothing yet</b>Activity appears here as soon as a milestone moves.</div>}
      <ul className="feed">{view.events.map((e, i) => <li key={i} className={'ev-' + e.kind}><time>{when(e.at)}</time><span>{e.text}</span></li>)}</ul>
    </section>
  </>);
}
