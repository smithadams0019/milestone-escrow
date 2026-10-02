# Milestone Escrow

**Live demo:** https://d9zf4cgc4ktxw.cloudfront.net

**API:** https://oop7bwgirxxofwjyi67b2auk2q0ghwbv.lambda-url.us-east-1.on.aws


Disaster-rebuild money held against construction milestones. When an inspector signs off, one PayPal Payouts batch pays the general contractor and every subcontractor beneath it, in the same action. The money cannot stall at the top of the chain.

Built for the PayPal AI Hackathon (project 3 of 5). MIT licensed. Sandbox only: no real money moves.

## For the submission

Raw material for the Devpost write-up and the video script. None of this is in the app: the app shows the chain, the money and the ledger.

### The problem, and the statute behind it

Federal rebuild money reaches a state, the state hires a general contractor, and then payment stops somewhere in the chain. Subcontractors go unpaid, crews leave, construction halts, and families stay in motels.

The legal position is the strongest argument for this product, and it is statutory:

- North Carolina's prompt-payment law, **N.C.G.S. ch. 22C**, requires payment to subcontractors within **7 days** and charges interest at **1% a month**.
- **§ 22C-6 excludes residential work of 12 or fewer units.** The subcontractors whose unpaid invoices stalled the state's hurricane rebuild programme are exactly the population the statute carves out.
- With no prompt-payment right, the fallback is a **ch. 44A mechanic's lien**: 120 days to file, 180 days to sue. The lien's ultimate remedy is **a forced sale of the hurricane victim's home**, enforced against the one party in the chain who never failed to pay anybody.

Escrow removes the dispute before it starts. The money is already committed, and the inspector's signature pays everyone.

### Verified figures (and what is not claimed)

Source: North Carolina Office of the State Auditor, *North Carolina Office of Recovery and Resiliency: A Report on the Homeowner Recovery Program*, report PER-2025-4902, 19 November 2025. Research dossier: `../../research/disaster/FINDINGS.md`, finding 5.

| Figure | Value |
|---|---|
| Outstanding contractor invoices, ReBuild NC, April 2025 | **$37.6m** |
| One approval step (grant determination), one of eight | **936 days** |
| Families in temporary housing | more than **1,400 days** |
| Vendor payments made without verification | exceeding **$784 million** (the auditor's wording) |

Authorities:

- ***Patriot Construction v. VK Electrical Services*** (Md. App., 2 March 2023): pay-when-paid upheld as a condition precedent, $64,575.09 affirmed after **six years and seven months** to resolve a $64,577 invoice.
- ***Five Rivers Carpenters v. Covenant Construction***, 114 F.4th 957 (8th Cir. 2024): a Miller Act bond reaches unpaid benefit contributions. **The opinion states no dollar figure, so none is attached.**

Not claimed, on purpose:

- Restore Louisiana's **$64,611,705** is *obligated minus disbursed*. It is not a total of refused invoices.
- There is **no measured national figure** for how long US subcontractors wait to be paid. No government measurement exists, and this project does not substitute an estimate.

### The with / without contrast (the demo beat)

With milestone escrow: an inspector signs, and one PayPal batch pays the contractor and four subcontractors in the same minute. Nobody is waiting on anybody, and the house is never a party to a dispute.

Without it: the same $37,000 reaches the general contractor and stops. Day 7 passes with no statutory right to payment, because § 22C-6 excludes the job. By day 120 the subcontractor is deciding whether to file a lien against the homeowner's house, and by day 180 the window to sue closes. The remedy the lien ultimately offers is a forced sale of the home of the one party who paid everyone on time. (Days count from the subcontractors' last day on site. The 120 and 180 day periods are from the research dossier, ch. 44A.)

Suggested video order: the 936-day and 1,400-day figures, then the § 22C-6 carve-out, then the live release (contractor and four subcontractors land together), then the contrast above.

## What it does

1. **Hold.** A $120,000 grant is held against five milestones. Each has a fixed split between the contractor and its subcontractors.
2. **Review.** An inspection report goes to a Bedrock agent (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`, Converse API with tool use). It reads the report, the milestone criteria, the payment tree and the escrow position, dry-runs the payout batch, then either calls `release_milestone` or `withhold_release`. A fixed rules gate inside `release_milestone` re-checks the agent's own assessment: recorded sign-off, a named licensed sign-off inside the report, confidence of at least 0.75, and every requirement shown as PASS. If anything fails the tool returns an error, the agent must withhold, and no money moves. The report text is untrusted; an instruction hidden in it is flagged and ignored.
3. **Pay the chain.** One `POST /v1/payments/payouts` pays the contractor and every subcontractor. A `POST /v2/invoicing/invoices` records the draw with line items tied to the milestone and the inspection id.
4. **Show everyone.** Status comes from each payout *item*. A batch can read `SUCCESS` while every item inside it is `UNCLAIMED`, which was observed and is why the product never trusts the batch status.

### Amounts

The ledger, the screen and the PayPal payout all carry the same figure: the general contractor is paid $4,500 and the framing subcontractor $17,000 as real payout amounts (sandbox money). Earlier builds scaled amounts down while the shared sandbox balance was small; the scaling mechanism (`SANDBOX_DIVISOR` in `backend/src/seed.mjs`, now 1) is kept, and any batch sent at another scale is labelled in the UI ("sent as …") and reconciled at its own scale.

## Engineering depth

- **Double-entry ledger** (`backend/src/ledger.mjs`). Every movement is two balanced entries: grant funded, released to a payee (in transit), landed (paid), returned, reversed. Entries are written create-only under deterministic keys, so replaying a sync cannot post twice. Held + in transit + paid always equals funded. `POST /api/reconcile` compares the ledger with live PayPal for every batch and item (amount, status position, missing or foreign items, batch total, unknown status) and reports drift without auto-correcting it.
- **Payout failure modes.** Items are polled to a terminal state. `UNCLAIMED` items show a countdown (PayPal returns them to the sender after 30 days) and can be cancelled. A cancelled or failed item returns to escrow in the ledger. Re-paying a corrected address is refused unless the old payment is verifiably dead, and its batch id is derived from the attempt count so a double click cannot pay twice. Partial batches are shown as partial.
- **Idempotency.** Each release uses a deterministic `sender_batch_id` and the same value as `PayPal-Request-Id`. If PayPal answers "already exists", the existing batch is fetched and adopted (after checking recipients and amounts match), so the money is never sent a second time and the caller sees success. Invoices do the same with `invoice_number`. Proven live in `tests/live-replay.mjs`.
- **Webhooks.** `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.*` and `INVOICING.INVOICE.PAID` are verified with `POST /v1/notifications/verify-webhook-signature`. A bad signature gets 401 and is ignored. A verified event is stored, acknowledged within a bounded 2.5 seconds, and only nudges a re-read: PayPal's own `GET` stays the source of truth.
- **No MCP tool reaches Payouts**, so everything is direct REST (`backend/src/paypal.mjs`).

## Contradictions in PayPal's own documentation, checked against the live spec

Live spec: `https://developer.paypal.com/api/payments.payouts-batch/v1/schema.json` (Payouts **1.9**). The slug `payments.payouts` returns 404, and the GitHub OpenAPI repo is stale.

| Question | What the live schema states | What the sandbox did |
|---|---|---|
| Items per call | `maxItems: 15000` | not tested at size |
| `recipient_type` values | schema enum: `EMAIL`, `PHONE`, `PAYPAL_ID`. The request-property prose adds a fourth, `USER_HANDLE`. PayPal's AI-toolkit file says `VENMO_HANDLE`. | `USER_HANDLE`, `VENMO_HANDLE` and a bogus value all failed the same way with an email receiver ("Receiver is invalid or does not match with type"), so the type is validated against the receiver's shape. The sandbox accepted `PHONE` with a +1 number, although the docs say it does not support it. |
| Per-item dollar cap | **The spec states none.** Other PayPal pages say $20,000, $60,000 (registered recipients) and $20,000 (unregistered). | Payouts of 19,999.99, 20,000.00, 20,000.01, 25,000 and 50,000 to unregistered receivers were all **accepted**. The sandbox enforces no per-item cap; the only limit hit was `INSUFFICIENT_FUNDS`. |
| Mixed currencies in one batch | not stated | refused: "Multiple currencies within a batch is not allowed" |

The product enforces the lowest documented cap ($20,000 per item) before calling PayPal. Output is in `TEST-RESULTS.md`.

## Architecture

```
React + Vite  ->  S3 + CloudFront (private bucket, origin access control)
        |
        v  fetch
Lambda Function URL (Node 22, one function, no API Gateway)
   |-- DynamoDB on-demand: project, batches, inspections, ledger entries, events
   |-- SSM Parameter Store: PayPal secret (SecureString), webhook id
   |-- Bedrock Converse (tool-use agent)
   '-- PayPal REST: payouts, payout items, invoicing, webhook verification
```

Cost while idle is close to zero: DynamoDB on-demand, Lambda per request, S3 and CloudFront at demo traffic. A daily cap on inspections bounds Bedrock spend.

## Run it

Local:

```
cd backend && npm i && npm test                  # 37 unit tests, no network
cd backend && PORT=8793 node src/local.mjs       # API on localhost with an in-memory store
cd frontend && npm i && npx vite                 # UI on :5193, proxies /api to :8793
```

`../../.env` must hold the PayPal sandbox credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_SECRET`, `PAYPAL_API`).

Deploy (account 854924711083, us-east-1, plain `aws` CLI): `./deploy.sh`. It is safe to re-run. It creates the table, SSM parameters, IAM role, Lambda and Function URL, registers the PayPal webhook, builds the UI, and creates the bucket and CloudFront distribution. It prints the URLs and writes `.deploy-state.json`.

### Make the payments land (one step)

Sandbox payouts to an address with no PayPal sandbox account end as `UNCLAIMED`, which the product handles and shows. To see the green *Landed* state, create **one** sandbox personal account in the PayPal developer dashboard and put its email in `.recipients.json` for every payee:

```
{"gc":"sb-xxxx@personal.example.com","concrete":"sb-xxxx@personal.example.com", ... }
```

Then `./deploy.sh` and use Reset demo. One account can receive all nine payees.

## Accessibility, measured

Contrast ratios are computed from the shipped design tokens by `scripts/contrast.mjs` (output in `docs/contrast-output.txt`). Text pairs need 4.5:1, non-text 3:1.

| Theme | Pair | Ratio | Needs |
|---|---|---|---|
| light | body text on page: ink #1c2420 on page #f5f1e8 | **14.09:1** | 4.5:1 |
| light | body text on cards: ink #1c2420 on card #fdfbf6 | **15.35:1** | 4.5:1 |
| light | secondary text on page: ink2 #4f5a54 on page #f5f1e8 | **6.37:1** | 4.5:1 |
| light | secondary text on cards: ink2 #4f5a54 on card #fdfbf6 | **6.95:1** | 4.5:1 |
| light | secondary text on grid group bands: ink2 #4f5a54 on band #ece6d6 | **5.77:1** | 4.5:1 |
| light | landed cell text: ok-fg #174a2e on ok-bg #e1eee4 | **8.54:1** | 4.5:1 |
| light | moving / unclaimed cell text: warn-fg #7d4a08 on warn-bg #fbefd5 | **6.45:1** | 4.5:1 |
| light | blocked / failed cell text: bad-fg #8a352c on bad-bg #f5dcd7 | **6.13:1** | 4.5:1 |
| light | awaiting inspection cell text: idle-fg #575f5a on card #fdfbf6 | **6.37:1** | 4.5:1 |
| light | green text on card: ok-fg #174a2e on card #fdfbf6 | **9.88:1** | 4.5:1 |
| light | amber text on card: warn-fg #7d4a08 on card #fdfbf6 | **7.11:1** | 4.5:1 |
| light | red text on card: bad-fg #8a352c on card #fdfbf6 | **7.73:1** | 4.5:1 |
| light | button text on accent: on-accent #ffffff on accent #1f5a3a | **8.13:1** | 4.5:1 |
| light | navigation text: nav-fg #d9e8de on nav-bg #1f5a3a | **6.41:1** | 4.5:1 |
| light | active navigation text: nav-fg-on #ffffff on nav-bg #1f5a3a | **8.13:1** | 4.5:1 |
| light | focus ring / non-text accent vs card (3:1): accent #1f5a3a on card #fdfbf6 | **7.87:1** | 3:1 |
| light | input and cell borders (3:1): line-strong #858c82 on card #fdfbf6 | **3.34:1** | 3:1 |
| dark | body text on page: ink #e8ebe5 on page #101512 | **15.33:1** | 4.5:1 |
| dark | body text on cards: ink #e8ebe5 on card #171e1a | **14.10:1** | 4.5:1 |
| dark | secondary text on page: ink2 #a9b3ab on page #101512 | **8.54:1** | 4.5:1 |
| dark | secondary text on cards: ink2 #a9b3ab on card #171e1a | **7.86:1** | 4.5:1 |
| dark | secondary text on grid group bands: ink2 #a9b3ab on band #1f2923 | **6.95:1** | 4.5:1 |
| dark | landed cell text: ok-fg #9bd9b2 on ok-bg #1b3626 | **8.09:1** | 4.5:1 |
| dark | moving / unclaimed cell text: warn-fg #f0c477 on warn-bg #33270f | **8.95:1** | 4.5:1 |
| dark | blocked / failed cell text: bad-fg #f4aca3 on bad-bg #3b1d19 | **8.20:1** | 4.5:1 |
| dark | awaiting inspection cell text: idle-fg #aab3ac on card #171e1a | **7.88:1** | 4.5:1 |
| dark | green text on card: ok-fg #9bd9b2 on card #171e1a | **10.48:1** | 4.5:1 |
| dark | amber text on card: warn-fg #f0c477 on card #171e1a | **10.40:1** | 4.5:1 |
| dark | red text on card: bad-fg #f4aca3 on card #171e1a | **9.12:1** | 4.5:1 |
| dark | button text on accent: on-accent #08130c on accent #5db582 | **7.57:1** | 4.5:1 |
| dark | navigation text: nav-fg #bcd5c4 on nav-bg #0c3a22 | **8.18:1** | 4.5:1 |
| dark | active navigation text: nav-fg-on #ffffff on nav-bg #0c3a22 | **12.77:1** | 4.5:1 |
| dark | focus ring / non-text accent vs card (3:1): accent #5db582 on card #171e1a | **6.79:1** | 3:1 |
| dark | input and cell borders (3:1): line-strong #6f7d73 on card #171e1a | **3.93:1** | 3:1 |

Other measures:

- Type: body 14px, nothing under 11px (HIG minimum is 10pt, desktop default 13pt). No weights under 400.
- Controls: buttons and inputs are at least 28px tall, most 36 to 44px; the milestone chips are 44px.
- Colour is never the only signal. Every status has a word and an icon: *Landed*, *In motion*, *Sent, unclaimed*, *Awaiting inspection*, *Blocked*, *Failed*.
- Full keyboard use with a visible 3px focus ring; Escape closes dialogs and focus is trapped inside them; a skip link is provided.
- `prefers-reduced-motion` removes the cascade, and the released column gets a static outline instead.
- Light and dark themes come from the same semantic tokens, follow the system setting, and can be switched with the button in the header.
- Tested at 360, 768, 1280 and 1920 pixels with no horizontal page scroll (see `TEST-RESULTS.md`). Below 1000px the grid becomes one card per milestone.

## Known gaps

- **Items cannot show *Landed* with the default recipients.** Every payout in the sandbox ends `UNCLAIMED` until `.recipients.json` points at a registered sandbox personal account (see above). This was not possible to do from here: sandbox accounts cannot be created through the API.
- **A real `FAILED` item was not produced.** The sandbox gave real `UNCLAIMED`, `RETURNED` (after cancel) and `INSUFFICIENT_FUNDS` outcomes. The failed-item handling is tested against PayPal's documented `ERRPYO` simulation ids, which are canned responses.
- Bedrock on the shared account throttles. The agent backs off briefly, then moves from the Sonnet 4.5 US profile to the same model on the global profile, then to Haiku 4.5. The model used is recorded on every decision and the rules gate is identical for all three. If every model is throttled the request fails with nothing released (observed: one 100-second failure during testing, kept in `tests/deployed.run2-throttled.out.txt`).
- The app is public with no sign-in, because it only moves sandbox money. A real deployment needs authentication, role separation (inspector, programme officer, contractor) and a licensed escrow holder; PayPal balances are not regulated escrow.
- All parties, inspectors, licence numbers and reports in the seed data are invented.
