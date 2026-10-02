# Build log - Milestone Escrow (PayPal AI Hackathon, project 3 of 5)

Running log, newest at the bottom. Written as I go so a session restart loses nothing.

## 2026-10-02 - discovery (done before any code)
- Read research/disaster/FINDINGS.md finding 5. Figures and the 22C-6 / 44A argument taken from it verbatim.
- Fetched live specs to docs/: payouts-schema.json (Payouts 1.9) and invoicing-schema.json.
- Sandbox facts found by probing, not by reading docs:
  - Sandbox business float is roughly $3,000-$5,000 (payout of 5000.00 -> INSUFFICIENT_FUNDS, 3000.00 accepted). A $120,000 programme cannot be paid at face value, so the demo moves ledger amounts at 1:500 (see README).
  - Unregistered email -> item UNCLAIMED / RECEIVER_UNREGISTERED. Registered-but-unconfirmed account -> UNCLAIMED / RECEIVER_UNCONFIRMED.
  - Batch status reached SUCCESS while every item was UNCLAIMED. Batch SUCCESS != money delivered. The product reads item status, never batch status.
  - Invalid receiver ("not-an-email") is rejected up-front, 422-style VALIDATION_ERROR, nothing created (batch is atomic on validation).
  - Invoice create works (returns href, only the id in the link).
- Decision: webhooks are treated as a nudge; authoritative state is always re-read with GET /v1/payments/payouts/{id}.

## 2026-10-02 - backend core written (backend/src)
- seed.mjs (invented parties, 5 milestones, $120,000 ledger, 1:500 sandbox scale), domain.mjs (pure logic: plan/validate/rollup), paypal.mjs (direct REST), bedrock.mjs (Converse + forced tool call + code-side release gate), store.mjs (DynamoDB w/ optimistic version + memory twin), service.mjs (inspect -> gate -> lock -> payout batch -> invoice; cancel/reissue; webhook-as-nudge; reset), handler.mjs (Function URL router), local.mjs (same router on localhost).
- First live smoke (memory store, real PayPal sandbox + real Bedrock): M1 report -> MET 0.98 -> batch XQHKPUCXR4R96, invoice created. Works end to end.
- Release rule lives in code (gate()), not in the model: sign-off flag AND decision MET AND confidence >= 0.75 AND report carries a named licensed sign-off AND every requirement PASS.

## 2026-10-02 - tests + coordinator UI reference
- backend unit tests: 21 pass (node --test). Live PayPal script tests/live-paypal.mjs: all pass, output in tests/live-paypal.out.txt.
- Findings: cancel of UNCLAIMED returns transaction_status RETURNED (not CANCELED). Sandbox float is NOT stable: rejected >=5000 early, later accepted a 50,000.00 payout (cancelled it) and rejected 60,000. Kept 1:500 scale so cost is trivial either way. Canned ids (ERRPYO015...) 404 if ?page_size is appended.
- No registered sandbox personal accounts exist for this app, so every real item ends UNCLAIMED (RECEIVER_UNREGISTERED). SUCCESS-to-item needs 8 personal sandbox accounts created in the dashboard (no API). Code reads RECIPIENTS_JSON for that.
- Coordinator sent a UI reference (ref-escrow-muster.png): nav bar + tabs, filter row, diagnostic panel + 4 tiles + stepped chart, weekly grid (people x days) -> parties x milestones, bottom summary bar. Palette: forest green on warm off-white, amber pending, muted red blocked. No purple. Writing own CSS.

## 2026-10-02 - UI built; coordinator asks to go deeper (6 items)
- Frontend (React+Vite) built: chain grid, without-escrow scrubber, case, ledger, inspection drawer. Own CSS. Screens in shots/.
- Coordinator extras: (1) double-entry ledger + reconciliation vs PayPal, (2) proper failure modes (unclaimed/partial/retry w/o double pay), (3) Bedrock tool-use agent that can refuse, (4) webhook signature verification + tamper test, (5) PayPal-Request-Id idempotency, (6) spec contradiction + cap boundary tests.
- NOTE: spec URL given was payments.payouts/v1; the real one is payments.payouts-batch/v1 (checked both, see below).
- Live probe (tests/live-probe-spec.mjs), sandbox, real output kept in TEST-RESULTS: payments.payouts/v1 spec URL = 404; payments.payouts-batch/v1 = 200 (Payouts 1.9). Sandbox accepted per-item 19,999.99 / 20,000.00 / 20,000.01 / 25,000 / 50,000 to unregistered receivers: NO per-item cap enforced in sandbox (so the three documented caps 20k/60k/20k cannot be separated here). Multi-currency batch -> VALIDATION_ERROR (so currency cannot be used to force a partial failure). recipient_type USER_HANDLE/VENMO_HANDLE/BOGUS with an email receiver -> "Receiver is invalid or does not match with type" (type is validated against receiver shape; cannot tell which 4th value is legal without a Venmo handle). PHONE with +14085551234 was ACCEPTED in sandbox (docs say sandbox does not support PHONE).
- Real item-level FAILED cannot be produced in the sandbox with tools available; PayPal's documented ERRPYO simulation ids are used for FAILED, real runs for UNCLAIMED/RETURNED.

## 2026-10-02 - depth pass
- ledger.mjs: double-entry (fund/submit/land/return/reverse), create-only keyed posts (replay-safe), trial balance + identity (held+transit+paid==funded), reconcile() against live PayPal (amount, status position, missing/foreign items, batch total, unknown status).
- agent.mjs: Bedrock Converse tool-use loop with 7 tools incl. compose_payout_batch (dry run), release_milestone (rules gate inside the tool), withhold_release. PayPal/ledger failures abort the loop (not the model's problem). Default on no decision = withhold.
- Idempotency: PayPal-Request-Id = deterministic sender_batch_id on payouts and invoices; duplicate sender_batch_id => adopt the batch PayPal links to; re-issue derives id from attempt count and refuses unless old item is dead.
- Webhooks: with PAYPAL_WEBHOOK_ID set, unverified => 401 + ignored.
- Bug found by tests: same-millisecond ledger entries replayed land before submit (alphabetical tiebreak). Fixed with causal ordering.
- unit tests: 36 pass.
- Coordinator then raised the bar to SHIP-READY: every control works, HIG contrast/size, plain writing (no "we"), all states incl. partial, confirm-before-release, 360-1920 responsive, light+dark, reduced motion, no-colour-alone. UI rework follows.

## 2026-10-02 - UI iteration log (screens in shots/r1 ... r6, flow1-3)
Round 1 (shots/r1, shots/chain1.png): 6/10. Chart (260px tall) pushed the grid below the fold so the signature moment was invisible; empty cells drawn as dashed boxes made the grid noisy; 360px chart text unreadable; tab hash did not switch tabs; raw colours instead of tokens, no dark mode, inert "selects" in the filter bar, window.confirm for reset.
Round 2 (shots/r2-r4): 7.5/10. Tokenised light/dark, contrast script, confirm dialogs, status icons+words, phone cards. Found: event feed rows picked up the .verdict style (class collision), release banner/grid below chart, tablet (768) grid scrolled sideways.
Round 3 (shots/r5-r6): 8/10. Grid moved above chart, release banner scrolls into view, grid becomes cards under 1000px, chart replaced by progress bar under 1000px, case page got a "where the money stops" map. Remaining honest gaps: items can never show the green Landed state with the placeholder recipients (needs a registered sandbox account), and the cascade is amber, not green, in the screenshots for that reason.
Score today: 8/10. Not claiming 9: the Landed state has not been seen with real PayPal data.

## 2026-10-02 - cut pass, deploy, final state
- Coordinator design standard (cut clutter): removed milestone chips (duplicated the column headers), grid title bar (duplicated the project name), legend (duplicated the bottom bar), chart (moved to the Ledger view), zero-count status entries, the "sent as" sandbox line when amounts equal, the second paragraph on The case page (the map carries it). Locked cells became dashed. Score after the cut: 8.5/10 (shots/r8, shots/r9-cloudfront). Not 9: the green Landed state is still unseen with real data, and the phone ledger tables scroll sideways inside their frame.
- Sandbox balance was topped up by the coordinator, so amounts are real (divisor 1). Reference batch for milestone 1 regenerated at real amounts (batch 3UA36U2DS3626).
- Deployed: Lambda escrow-api (Function URL), DynamoDB escrow-ledger, SSM /escrow/*, S3 escrow-web-854924711083, CloudFront E3GNI4UPIVS532, PayPal webhook 1PC447669J702510S. deploy.sh re-runs cleanly.
- Bugs found late and fixed: Function URL needed a second permission (CLI too old, SDK script added); duplicate CORS header (found only by loading the site in a browser); Bedrock throttling on the shared account (fallback chain); hung test client (timeouts).
- Deployed end-to-end suite passes (tests/deployed.out.txt). Details and failures in TEST-RESULTS.md.

## 2026-10-02 - aggressive cut
- Removed the "The case" and "Without escrow" tabs (files deleted, dead CSS removed). The argument moved to README "For the submission" (statute, 22C-6 carve-out, lien consequence, $37.6m / 936 days / 1,400 days, the two authorities with the Five Rivers no-dollar-figure warning, the with/without beat, suggested video order).
- Nav is now two tabs: The chain, Ledger. An old #case or #without link opens The chain on a fresh load (checked). The Ledger chart is hidden under 1000px.
- Default view (The chain) after the cut: 252 words, 1435px tall at 1280, 2498px at 360, no horizontal overflow (tests/measure.out.txt, measure-deployed.out.txt). Release flow re-driven in the UI at 1280 and 360 against the local API with the scripted model; deployed build loads cleanly. The agent and payout paths were not re-run on this deploy (UI-only change).
