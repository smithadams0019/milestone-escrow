import React, { useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';
import { usd, usd2, sandboxOf } from './util.js';

const STEPS = ['Reading the inspection report', 'Checking each requirement against the text', 'Verifying the payout batch', 'Sending one batch to PayPal'];

export function Trace({ agent }) {
  if (!agent?.trace?.length) return null;
  return (<details className="trace"><summary>Agent trace: {agent.trace.length} tool calls over {agent.turns} turns</summary>
    <ol>{agent.trace.map((t, i) => <li key={i} className={t.status === 'error' ? 'error' : ''}><code>{t.turn}. {t.tool}</code><span>{t.status === 'error' ? 'refused' : t.ms != null ? `${t.ms} ms` : ''}</span>
      {t.input && <span className="o">in: {t.input}</span>}<span className="o">out: {t.output}</span></li>)}</ol></details>);
}

export default function Inspect({ view, n: start, onClose, onDone }) {
  const open = view.milestones.filter((m) => m.state === 'awaiting' || m.state === 'held');
  const [n, setN] = useState(start);
  const m = view.milestones.find((x) => x.n === n);
  const samples = view.samples[n] || {};
  const [text, setText] = useState(''); const [name, setName] = useState(''); const [lic, setLic] = useState(''); const [signed, setSigned] = useState(true);
  const [phase, setPhase] = useState('form'); const [step, setStep] = useState(0); const [res, setRes] = useState(null); const [err, setErr] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const first = useRef(null);
  const use = (s) => { setText(s.text); setName(s.inspector?.name || ''); setLic(s.inspector?.licence || ''); setSigned(!!s.signedOff); };
  useEffect(() => { setText(''); setName(''); setLic(''); }, [n]);
  useEffect(() => { first.current?.focus(); }, []);
  useEffect(() => { const k = (e) => e.key === 'Escape' && phase !== 'work' && !confirm && onClose(); document.addEventListener('keydown', k); return () => document.removeEventListener('keydown', k); }, [phase, confirm, onClose]);
  useEffect(() => { if (phase !== 'work') return; const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 4500); return () => clearInterval(t); }, [phase]);

  const go = async () => {
    setConfirm(false); setPhase('work'); setStep(0); setErr(null);
    try { setRes(await api.inspect({ n, report: text, inspector: { name, licence: lic }, signedOff: signed })); setPhase('result'); }
    catch (e) { setErr(e); setPhase('error'); }
  };
  const sandboxTotal = usd2(sandboxOf(m.totalCents, view.project.divisor));

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && phase !== 'work' && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Release milestone ${n}`}>
        <div className="dHead"><h2>Release milestone {n}</h2><button className="x" onClick={onClose} disabled={phase === 'work'} aria-label="Close">×</button></div>

        {phase === 'form' && <>
          <label className="lab">Milestone
            <select ref={first} value={n} onChange={(e) => setN(Number(e.target.value))}>{open.map((o) => <option key={o.n} value={o.n}>{o.n}. {o.title} ({usd(o.totalCents)})</option>)}</select>
          </label>
          <div className="req"><b>The report must prove</b><ul>{m.requirements.map((r) => <li key={r}>{r}</li>)}</ul></div>
          <div className="lab">Fill from a sample report
            <div className="chips">
              {Object.entries(samples).map(([k, s]) => <button key={k} className={'chip tone-' + (k === 'injection' ? 'bad' : k === 'fail' ? 'warn' : 'ok')} onClick={() => use(s)}>{s.label}</button>)}
              {!Object.keys(samples).length && <span className="hint">No sample for this milestone. Paste a report below.</span>}
            </div>
          </div>
          <label className="lab">Inspection report text<textarea rows={11} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the inspector's report, or fill from a sample above" /></label>
          <div className="two">
            <label className="lab">Inspector name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></label>
            <label className="lab">Licence number<input value={lic} onChange={(e) => setLic(e.target.value)} autoComplete="off" /></label>
          </div>
          <label className="check"><input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> The inspector has signed this off</label>
          <p className="fine">The release agent reads the report. A fixed rules check then decides: sign-off recorded, a named licensed sign-off inside the report, and every requirement shown as passed. If any fails, no money moves.</p>
          <button className="btn primary wide" disabled={text.trim().length < 20} onClick={() => setConfirm(true)}>Check report and release</button>
          {text.trim().length < 20 && <p className="fine">Add a report of at least 20 characters to continue.</p>}
        </>}

        {phase === 'work' && <div role="status" aria-live="polite"><ol className="steps">{STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}><span className="dot" />{s}</li>)}</ol>
          <p className="fine">The agent can take up to a minute when the model is busy. Closing is disabled so the release is not interrupted.</p></div>}

        {phase === 'error' && <div role="alert"><div className="banner red"><b>{err.code === 'ESCROW_UNDERFUNDED' || err.code === 'INSUFFICIENT_FUNDS' ? 'Escrow is underfunded.' : 'Release did not complete.'}</b> {err.message}</div>
          <p className="fine">No payment was made. Milestone {n} is still in escrow.</p><button className="btn" onClick={() => setPhase('form')}>Edit the report</button></div>}

        {phase === 'result' && res && <Result res={res} onDone={() => onDone(res)} onAgain={() => setPhase('form')} />}
      </aside>

      {confirm && <Modal title={`Release milestone ${n}?`} onClose={() => setConfirm(false)}>
        <p>If the agent finds every requirement shown as passed, <b>{m.splits.length} payment{m.splits.length > 1 ? 's' : ''} leave escrow in one PayPal batch</b>:</p>
        <ul>{m.splits.map((s) => { const p = view.project.payees.find((x) => x.id === s.payee); return <li key={s.payee}>{p.name}: {usd(s.cents)}</li>; })}</ul>
        <p><b>{usd(m.totalCents)}</b>{sandboxTotal !== usd2(m.totalCents) ? ` in the ledger, sent as ${sandboxTotal} in the PayPal sandbox` : ' of sandbox money (no real funds)'}. A payment that has landed cannot be recalled. If the report does not prove the work, nothing is paid.</p>
        <div className="row"><button className="btn" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary" onClick={go}>Check report and release</button></div>
      </Modal>}
    </div>
  );
}

function Result({ res, onDone, onAgain }) {
  const v = res.inspection.verdict;
  return (<div>
    <div className={'verdict ' + (res.released ? 'tone-ok' : 'tone-bad')} role="status">
      <b><Icon name={res.released ? 'check' : 'stop'} size={16} /> {res.released ? `Released: ${res.batch.items.length} payments in one batch` : 'Withheld: no money moved'}</b>
      <span>{res.released ? `PayPal batch ${res.batch.id}. The contractor and every subcontractor were paid in the same action.` : (res.reasons || []).join(' ')}</span>
    </div>
    <p>{v.summary}</p>
    <ul className="cl" style={{ marginTop: 12 }}>{(v.checklist || []).map((c) => <li key={c.requirement} className={c.status}><b>{c.status === 'PASS' ? 'Passed' : c.status === 'FAIL' ? 'Failed' : 'Not shown'}</b><span>{c.requirement}<em>{c.evidence}</em></span></li>)}</ul>
    {v.anomalies?.length > 0 && <div className="banner amber" style={{ marginTop: 12 }}><b>Flagged in the report:</b> {v.anomalies.join(' ')}</div>}
    {res.inspection.agent?.refusedAttempt && <div className="banner amber" style={{ marginTop: 12 }}><b>Release refused by the rules check:</b> {res.inspection.agent.refusedAttempt.reasons.join(' ')}</div>}
    <Trace agent={res.inspection.agent} />
    <p className="fine">Model {String(v.modelId || '').replace('us.anthropic.', '')} · confidence {v.confidence}</p>
    <div className="row"><button className="btn primary" onClick={onDone}>{res.released ? 'Watch the chain' : 'Close'}</button>{!res.released && <button className="btn" onClick={onAgain}>Edit the report</button>}</div>
  </div>);
}
