import React from 'react';
import Icon from '../Icon.jsx';
import { usd } from '../util.js';

/**
 * The agent withholding money is the only thing here a person could not do faster
 * themselves, so it opens the page rather than sitting behind an inspection form.
 * Everything shown is the verdict the model actually returned.
 */
export default function Refusal({ milestone, onFix }) {
  const v = milestone?.verdict;
  if (!v || v.decision === 'MET') return null;

  const list = v.checklist || [];
  const met = list.filter((c) => c.status === 'PASS').length;

  return (
    <section className="panel refusal" aria-labelledby="ref-h">
      <div className="pHead">
        <div>
          <h1 id="ref-h">
            {usd(milestone.totalCents)} stayed in escrow. The report proved {met} of {list.length} requirements.
          </h1>
          <p>Milestone {milestone.n}, {milestone.title}. The agent read the inspector's report against the criteria and would not release on it.</p>
        </div>
      </div>

      <ol className="criteria">
        {list.map((c, i) => (
          <li key={i} className={c.status === 'PASS' ? 'c-pass' : 'c-missing'}>
            {c.status === 'PASS' ? <Icon name="check" /> : <span className="c-dash" aria-hidden="true">—</span>}
            <div>
              <b>{c.requirement}</b>
              <i>{c.status === 'PASS' ? c.evidence : 'Not shown in the report.'}</i>
            </div>
          </li>
        ))}
      </ol>

      {v.anomalies?.length > 0 && (
        <p className="anomaly">
          <span className="c-dash" aria-hidden="true">—</span> {v.anomalies[0]}
        </p>
      )}

      <div className="refusal-act">
        <button type="button" className="btn primary" onClick={() => onFix(milestone.n)}>
          Submit a complete report
        </button>
        <span>A report covering all {list.length} releases the money to every subcontractor at once.</span>
      </div>
    </section>
  );
}
