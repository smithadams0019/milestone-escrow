// A scripted stand-in for Bedrock's Converse API. It speaks the real tool-use protocol, so the REAL agent loop,
// tool handlers and rules gate all run; only the model's "decision" is scripted.
const asm = (reqs, status = (i) => 'PASS', extra = {}) => ({
  decision: 'MET', confidence: 0.95, inspector_signoff_found: true, anomalies: [], summary: 'ok',
  checklist: reqs.map((r, i) => ({ requirement: r, status: status(i), evidence: 'e' })), ...extra,
});
export function scriptedBedrock(modeIn = 'pass', log = []) {
  let call = 0;
  return {
    async send(cmd) {
      const mode = typeof modeIn === 'function' ? modeIn() : modeIn;
      const messages = cmd.input.messages; call++;
      log.push(messages.length);
      const last = messages[messages.length - 1];
      const tr = (last.content || []).filter((c) => c.toolResult).map((c) => c.toolResult);
      const crit = tr.map((t) => t.content[0].json).find((j) => j?.requirements);
      const out = (content) => ({ output: { message: { role: 'assistant', content } }, usage: { inputTokens: 10, outputTokens: 5 } });
      const use = (name, input = {}, i = 0) => ({ toolUse: { toolUseId: `t${call}-${i}`, name, input } });
      if (messages.length === 1) return out(['read_inspection_report', 'get_milestone_criteria', 'get_payment_tree', 'get_escrow_position'].map((n, i) => use(n, {}, i)));
      const refused = tr.some((t) => t.status === 'error');
      if (refused) return out([use('withhold_release', { assessment: asm(crit?.requirements || [], () => 'NOT_SHOWN', { decision: 'INSUFFICIENT_EVIDENCE' }), reason: 'rules gate refused my release' })]);
      if (crit) {
        const reqs = crit.requirements;
        if (mode === 'pass') return out([use('compose_payout_batch', {}, 0), use('release_milestone', { assessment: asm(reqs) }, 1)]);
        if (mode === 'fail') return out([use('withhold_release', { assessment: asm(reqs, (i) => (i === 1 ? 'FAIL' : 'PASS'), { decision: 'NOT_MET' }), reason: 'plumbing failed' })]);
        // "liar": claims MET while one requirement is FAIL -> the gate must refuse
        if (mode === 'liar') return out([use('release_milestone', { assessment: asm(reqs, (i) => (i === 1 ? 'FAIL' : 'PASS')) })]);
        if (mode === 'nosignoff') return out([use('release_milestone', { assessment: asm(reqs, () => 'PASS', { inspector_signoff_found: false }) })]);
        if (mode === 'silent') return out([{ text: 'I cannot decide.' }]);
      }
      return out([{ text: 'done' }]);
    },
  };
}
