export const MODEL = process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
export const MIN_CONFIDENCE = 0.75;

/**
 * Code, not the model, decides if money moves. The agent reports what the inspection report proves;
 * this gate refuses unless every condition below holds. It is called from inside the release_milestone tool,
 * so a model that tries to release on thin evidence is handed an error instead of a payout.
 */
export function gate(assessment, milestone, { signedOff }) {
  const reasons = [];
  if (!signedOff) reasons.push('No inspector sign-off was recorded with this submission.');
  if (assessment.decision !== 'MET') reasons.push(`The report does not show the milestone is met (${assessment.decision}).`);
  if (!(assessment.confidence >= MIN_CONFIDENCE)) reasons.push(`Confidence ${assessment.confidence} is below the ${MIN_CONFIDENCE} release threshold.`);
  if (!assessment.inspector_signoff_found) reasons.push('The report itself does not carry a named, licensed sign-off.');
  const cl = Array.isArray(assessment.checklist) ? assessment.checklist : [];
  const byReq = new Map(cl.map((c) => [c.requirement, c.status]));
  const missing = milestone.requirements.filter((r, i) => (byReq.get(r) ?? (cl.length === milestone.requirements.length ? cl[i].status : undefined)) !== 'PASS');
  if (missing.length) reasons.push(`${missing.length} requirement(s) not shown as PASS: ${missing.join('; ')}`);
  return { releaseBlocked: reasons.length > 0, reasons };
}
