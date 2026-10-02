import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import Chain from './views/Chain.jsx';
import Refusal from './views/Refusal.jsx';
import Ledger from './views/Ledger.jsx';
import Inspect from './InspectDrawer.jsx';
import Modal from './Modal.jsx';
import Icon from './Icon.jsx';

const TABS = [['chain', 'The chain'], ['ledger', 'Ledger']];
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } } };

export default function App() {
  const [view, setView] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(() => (TABS.some(([k]) => k === location.hash.slice(1)) ? location.hash.slice(1) : 'chain'));
  const [drawer, setDrawer] = useState(null);
  const [resetting, setResetting] = useState(false);
  const [flash, setFlash] = useState(null);
  const [theme, setTheme] = useState(() => store.get('escrow-theme') || 'light');
  const prev = useRef(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; store.set('escrow-theme', theme); }, [theme]);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const v = await api.state(refresh);
      const p = prev.current;
      if (p) for (const m of v.milestones) {
        const was = p.milestones.find((x) => x.n === m.n);
        if (was && was.state !== 'released' && m.state === 'released' && !m.reference) setFlash({ n: m.n, at: Date.now(), batchId: m.batchId });
      }
      prev.current = v; setView(v); setErr(null);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }, []);

  useEffect(() => { load(true); }, [load]);
  useEffect(() => {
    const open = view && view.milestones.some((m) => m.rollup && !m.rollup.settled);
    const t = setInterval(() => { if (!document.hidden) load(true); }, open ? 4000 : 20000);
    return () => clearInterval(t);
  }, [view, load]);
  useEffect(() => { const h = () => { const k = location.hash.slice(1); if (TABS.some(([t]) => t === k)) setTab(k); }; addEventListener('hashchange', h); return () => removeEventListener('hashchange', h); }, []);
  useEffect(() => { if (location.hash.slice(1) !== tab) history.replaceState(null, '', '#' + tab); }, [tab]);
  useEffect(() => { if (!flash) return; const t = setTimeout(() => setFlash(null), 12000); return () => clearTimeout(t); }, [flash]);

  if (!view) return (<div className="boot">{err
    ? <div className="bootErr" role="alert"><p><b>Unable to reach the ledger.</b></p><p>{err}. Check the connection, then try again.</p><p><button className="btn primary" onClick={() => load(true)}>Try again</button></p></div>
    : <div className="bootMsg" role="status"><span className="spin" /> Opening the ledger</div>}</div>);

  const open = view.milestones.find((m) => m.state === 'awaiting' || m.state === 'held');
  const waiting = view.milestones.filter((m) => m.state === 'awaiting' || m.state === 'held').length;
  const doReset = async () => { setResetting(false); try { const v = await api.reset(); prev.current = null; setFlash(null); setView(v); } catch (e) { setErr(e.message); } };

  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="nav">
        <div className="brand"><span className="mark" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20"><path d="M16 5v10m0 0l-8 5m8-5l8 5m-8-5v12" stroke="currentColor" strokeWidth="2.8" fill="none" strokeLinecap="round" /></svg></span>Milestone Escrow</div>
        <nav className="tabs" aria-label="Sections">
          {TABS.map(([k, label]) => (
            <button key={k} className="tab" aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>
              {label}{k === 'chain' && waiting > 0 && <span className="badge" aria-label={`${waiting} milestone${waiting > 1 ? 's' : ''} awaiting inspection`}>{waiting}</span>}
            </button>
          ))}
        </nav>
        <div className="navRight">
          {view.project.divisor > 1 && <span className="pill">Ledger scaled 1:{view.project.divisor}</span>}
          <button className="themeBtn" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}><Icon name={theme === 'dark' ? 'sun' : 'moon'} size={17} /></button>
        </div>
      </header>

      <div className="filters">
        <div className="where"><span className="pin" aria-hidden="true" /><span>{view.project.title}<small>{view.project.place} · run {view.project.run}</small></span></div>
        <span className={'live' + (busy ? ' busy' : '')} role="status"><i aria-hidden="true" />{busy ? 'Checking PayPal' : 'Up to date'}</span>
        <div className="grow" />
        <button className="icon" onClick={() => load(true)} aria-label="Refresh from PayPal" title="Re-read every open batch from PayPal"><Icon name="refresh" size={16} /></button>
        <button className="btn sm" onClick={() => setResetting(true)}>Reset demo</button>
        <button className="btn primary" disabled={!open} onClick={() => open && setDrawer(open.n)} title={open ? undefined : 'Every milestone has been released'}>
          {open ? `Release milestone ${open.n}` : 'All milestones released'}
        </button>
      </div>

      <main id="main">
        {err && <div className="banner red" role="alert">Unable to refresh: {err}. The last good state is shown. Try the refresh button.</div>}
        {tab === 'chain' && <>
          <Refusal milestone={view.milestones.find((m) => m.verdict && m.verdict.decision !== 'MET' && m.state !== 'released')} onFix={setDrawer} />
          <Chain view={view} flash={flash} onInspect={setDrawer} />
        </>}
        {tab === 'ledger' && <Ledger view={view} reload={() => load(true)} />}
      </main>

      {drawer && <Inspect view={view} n={drawer} onClose={() => setDrawer(null)} onDone={(r) => { setDrawer(null); load(true); if (r?.released) setTab('chain'); }} />}
      {resetting && <Modal title="Reset the demo?" onClose={() => setResetting(false)}>
        <p>Milestones 2 to 5 return to awaiting inspection and the ledger starts again. Milestone 1 stays released from the reference run.</p>
        <p>Batches already sent to PayPal are not undone.</p>
        <div className="row"><button className="btn" onClick={() => setResetting(false)}>Keep current state</button><button className="btn primary" onClick={doReset}>Reset demo</button></div>
      </Modal>}
    </div>
  );
}
