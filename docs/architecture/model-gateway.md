# Model gateway

Status: PR 1 (gateway core and app-pays) and PR 2 (charge lines) shipped;
PRs 3–4 are the plan. This
file is the plan and the contract; each PR in the stack updates it to match
what it shipped. § Shipped describes the code as it is.

The gateway is OpenStory's own model API: one fal-shaped surface (submit a
job, poll it, read a result URL) under `/api/v1/gateway`, in front of every
via. It runs inside the main Worker. It is extracted into its own service only
after the contract has held for the main app and for third parties.

## Decisions

- **Platform keys only.** A gateway call never uses an organization's own
  provider key. Every gateway job is billed.
- **Two ways to pay.**
  - _App pays:_ the caller sends an `osk_` key. The key's organization is
    charged. No margin, no cap.
  - _User pays:_ the caller sends an OAuth bearer token from auth-code + PKCE
    ("Sign in with OpenStory"). The organization picked on the consent screen
    is charged, up to the monthly cap the user set there.
- **Margin is server-side.** An app's margin is stored on its app row. It is
  never a request parameter: a public client has no secret.
- **Earnings are credits.** An app's organization earns wallet credits. They
  are not transferable, not redeemable, and are held before they can be spent.
  No cash payout exists.
- **Gateway platform fee is 0 for now.** `GATEWAY_PLATFORM_FEE_BPS` exists so
  the line can be turned on; the 7% top-up fee already applies to the money
  that funds the wallet.

## Surface

| Method and path                      | Purpose                                     |
| ------------------------------------ | ------------------------------------------- |
| `GET /api/v1/gateway/models`         | Models the gateway serves, with input shape |
| `POST /api/v1/gateway/jobs`          | Submit. Returns `202` and the job           |
| `GET /api/v1/gateway/jobs/$id`       | Status, result URLs, the charge (`?wait`)   |
| `POST /api/v1/gateway/jobs/estimate` | Price before submitting (PR 4)              |
| `POST /api/v1/gateway/charges`       | An app's own billing line (PR 4)            |

- A request names a model **key**, never an endpoint. The job is stamped with
  its `via`; poll follows the stamp; a job never hops between providers.
- `Idempotency-Key` on submit makes the trigger and the reservation idempotent.
- Results are stored in R2 in the step that generated them (#1645) and
  returned as absolute URLs.
- Every reference URL in a request goes through the upload rights check
  (`requireCheckedUploadRights`) before any provider sees it.
- OAuth callers need the `models:invoke` scope. `osk_` keys are unscoped.
- Kinds in this stack: `image`, `video`. Audio and LLM calls are follow-ups.

## Money

A job reserves its estimate at submit, settles its actual cost when it
finishes and releases the hold when it fails. A settled charge is one wallet
debit and one or more **charge lines**:

| Line kind       | Payee              | Amount                                |
| --------------- | ------------------ | ------------------------------------- |
| `provider_cost` | platform           | what the provider billed              |
| `platform_fee`  | platform           | `GATEWAY_PLATFORM_FEE_BPS` of cost    |
| `app_margin`    | app's organization | the app's `marginBps` of cost         |
| `app_charge`    | app's organization | a declared SKU's price, app-initiated |

- The lines of a charge always sum to the wallet debit. Both are written in
  one D1 batch, and lines exist only for a debit that happened.
- **Short capture.** When the balance cannot cover a charge above its hold,
  the debit is short. The lines are then filled in this order and the rest is
  cut: `provider_cost`, `platform_fee`, `app_charge`, `app_margin`. A payee
  line is cut first and the provider cost last: the platform paid the
  provider, and an app never earns on money the payer did not pay. A line cut
  to zero is not written. The shortfall is reported
  (`billing_skipped_deduction`), never recorded as a line.
- Each line is rounded half up to a whole microdollar on its own, and the
  total is the sum of the lines (`gatewayCharge`).
- `app_margin` and `app_charge` exist only on user-pays calls from a
  registered, active app. An app charging its own organization earns nothing.
- Margin is capped at `MAX_APP_MARGIN_BPS` (5000).
- An `app_charge` names a SKU the app declared in advance; an app cannot
  charge an arbitrary amount.
- The cap on a grant counts every line: settled lines this calendar month
  (UTC) plus live holds for that client and organization.

## Earnings

A payee line creates an earning row in state `pending`. After
`EARNING_HOLD_DAYS` (14) it matures: the app's organization wallet is credited
with a `credit_earned` transaction and a `creditBatches` row with source
`earned`. A charge reversed inside the hold cancels the earning instead.

## The stack

Each PR is based on the one before it.

1. **Gateway core and app-pays.** `src/gateway/` domain, `gateway_jobs`,
   `GatewayGenerationWorkflow`, the three core endpoints, the `models:invoke`
   scope, a per-organization rate limiter, single-line billing through the
   existing reservation and capture.
2. **Charge lines.** `charge_lines` table, a settle method that writes the
   debit and its lines together, the platform fee line, the gateway moved onto
   it. The job response shows the lines.
3. **Apps and user-pays.** `gateway_apps` (an OAuth client owned by an
   organization), `gateway_grants` (client, user, organization, monthly cap),
   the cap control on the consent screen, cap enforcement at reservation,
   spend and cap in Settings → Authorized apps, app registration in Settings →
   Developer.
4. **Margin, app charges and earnings.** `marginBps` on the app, the
   `app_margin` line, declared SKUs and `POST /gateway/charges`,
   `gateway_earnings` with the hold and the maturing sweep, the estimate
   endpoint and the price breakdown on the consent screen.

## Shipped (PR 1)

### Code

- `src/gateway/schema.ts`: the request schema (`gatewayJobRequestSchema`,
  OpenAPI `GatewayJobRequest`), the stored input, output and error types, and
  the model keys the gateway can serve. Client-safe.
- `src/gateway/server/models.ts`: the catalog `GET /gateway/models` lists,
  the platform vias (`gatewayVias`), and the hold estimate
  (`estimateGatewayJobCost`, the Studio estimators).
- `src/gateway/server/submit-job.ts`: `submitGatewayJob`, the whole submit.
- `src/gateway/server/read-job.ts`: the organization-scoped read behind GET.
- `src/gateway/server/api-documents.ts`: the response documents
  (`GatewayModelsResult`, `GatewayJob`) and their links.
- `src/gateway/server/platform-credentials.ts`: `platformOnlyCredentials`,
  the only credentials a run spends.
- `src/gateway/server/settle.ts`: `settleGatewayJob`, the one place a job is
  charged (PR 2: the debit and its lines, then the success).
- `src/gateway/server/workflows/gateway-generation-workflow.ts`:
  `GatewayGenerationWorkflow` (binding `GATEWAY_WORKFLOW`, trigger `/gateway`).
- `src/gateway/server/db/gateway-jobs.ts`: `scopedDb.gatewayJobs`; table
  `gateway_jobs` (`src/platform/server/db/schema/gateway-jobs.ts`).
- Routes: `src/routes/api/v1/gateway.models.ts`, `gateway.jobs.ts`,
  `gateway.jobs.$id.ts`. Thin; the logic is in `src/gateway/server/`.

### Request

```json
{ "kind": "image", "model": "gpt_image_2", "prompt": "…", "aspectRatio": "16:9",
  "referenceImageUrls": ["https://…"] }
{ "kind": "video", "model": "seedance_v2", "prompt": "…", "aspectRatio": "9:16",
  "duration": 8, "startImageUrl": "https://…" }
```

- `aspectRatio` is `16:9`, `9:16` or `1:1` (default `16:9`). Resolution is
  the app default (720p); it is not a request field yet.
- Video `duration` is snapped to the nearest length the model accepts and
  stored snapped; omitted, the shortest. A video takes a start frame **or**
  reference images, never both. The video mode follows: start frame →
  `frames`, references → `reference`, neither → `text` (the Studio
  endpoints, `studio-video-generation.ts`).

### Models

Image: every visible sequence still model (`IMAGE_MODELS` without `hidden`),
through `generateImageWithProvider`. Video: every visible sequence video
model (`IMAGE_TO_VIDEO_MODELS` without `hidden`) through the Studio
submit/poll, and a `requiresVia: 'byteplus'` model (Seedance 2.5, Seedance
2.0 Mini) only where the platform claims BytePlus Ark.

Not served, and why:

- Hidden models (Kling 3.0 Pro, Nano Banana 2, Krea 2 Turbo): no picker
  offers them either.
- The `/models` catalog's arbitrary fal endpoints: the gateway names model
  keys, never endpoints.
- Video edit mode, reference clips and audio, end frames, Ark drafts and a
  `count` above one: Studio-only today; each needs its own input checks
  (clip chains, lengths) before it can face a third party.
- Audio and LLM kinds: later in the stack (§ Not in this stack).

### Job lifecycle

`queued` → `running` → `succeeded` | `failed`. The row is written only
through `scopedDb.gatewayJobs`; it has no selection pointer, so it is a
`claim-discipline` exception like `generated_assets`.

1. **Submit** (`submitGatewayJob`): a known `Idempotency-Key` returns its
   job; else the model is checked against the platform vias, the account
   against the generation gate, every reference URL through
   `requireCheckedUploadRights`, the estimate is priced, the row is
   inserted, the hold is reserved, and the run is triggered. The run's
   payload is the normalized input plus the no-person verdicts
   (`likenessFromLedger`) for Ark; the run reads no job row.
2. **Image run:** generate and store to R2 in one `step.do` (#1645), record
   fal usage, then the tail (PR 2): `record-provenance` (`gateway_job`),
   `record-outputs`, and `settle`, which charges and marks the job succeeded
   in one step.
3. **Video run:** resolve the via, register Ark stills when the via is
   BytePlus (lease owner `gateway:<instanceId>`), submit, **stamp `via` and
   `providerJobId` on the row**, poll the submitted job (the poll follows the
   via on the submission, never a fresh resolution), release the Ark leases,
   price from the provider's usage (`studioVideoCostFromUsage`), store,
   then the same tail.
4. **Failure:** `onFailure` marks the row `failed` with
   `{ code, message }` (`CONTENT_REJECTED` for a content refusal, else
   `GENERATION_FAILED`; `NOT_STARTED` when the trigger itself failed) and
   releases Ark leases. The base class zeroes the hold (`ownsReservation`).

Unlike Studio, a video run does not resubmit after a content flag or after
Ark's InternalServiceError: one submit, and a failure is the answer.

### Keys and money

- `platformOnlyCredentials` resolves through `resolvePlatformOptionalKey`
  (`src/models/server/db/api-keys.ts`), which reads env and never the
  organization's key row. The run never touches `scopedDb.credentials`; a
  source test pins that, and `settleGatewayJob` refuses a result that
  reports `usedOwnKey`. The submit's likeness check (`classifyUpload`) runs
  on the platform LLM key too (`withPlatformLlmKey`).
- The hold is `reserveRunCredits(…, { providers: [] })`: no BYOK skip, so an
  organization with its own fal key is still held and charged.
- The settle is `billing.settleReservation` with the job's `reservationId`
  (PR 2; it was `deductWorkflowCredits` in PR 1), idempotency key
  `${instanceId}:gateway-settle`. A result the provider reports no cost for
  is charged the lines of the estimate (`estimateMicros` on the payload) at
  the snapshotted fee, which is exactly the hold, and reported as a missing
  cost, never settled free. `costMicros` on the row is the debit.
- Insufficient credits at submit is `402 INSUFFICIENT_CREDITS` in the
  `/api/v1` error envelope, and leaves no row, so the same key can be sent
  again after a top-up.

### Idempotency

The `Idempotency-Key` header (≤ 255 characters) is unique per organization
on `gateway_jobs`. The key binds the job; the job binds the rest: the
reservation key is `gateway:<jobId>` and the trigger's `deduplicationId` is
`gateway-<jobId>`. A replay returns the first job whatever the body says. A
key whose first submit was refused before the hold (credits, a bad upload)
is free again.

### Auth and limits

- `requiredOAuthScope` answers `models:invoke` for every `/api/v1/gateway`
  request, reads included. `osk_` keys are unscoped (app pays: the key's
  organization is charged). `oauthClientId` on the row is the token's
  client, for PR 3.
- `GATEWAY_RATE_LIMITER` (60 submits a minute per organization, namespace
  `2380`) is declared in all three wrangler blocks. A 429 is
  `{ error: { code: 'RATE_LIMITED' } }` with `Retry-After`. Reads are not
  throttled beyond the per-key limiter.

### Not yet (PR 1)

- No reconcile sweep for a job left `running` when both the run and its
  `onFailure` die; the hold expires on its own TTL.
- No estimate endpoint; the hold is not shown before submit.
- A reference image the check finds a real person in is refused
  (`400 ATTESTATION_REQUIRED`): the gateway has no portrait-attestation field
  yet. A raw URL is classified on first use, an organization's own upload by
  its existing verdict, and another organization's file is refused.

## Shipped (PR 2)

### Code

- `src/billing/charge-lines.ts`: `CHARGE_LINE_KINDS` and `inFillOrder`, the
  short-capture order. Client-safe.
- `src/platform/server/db/schema/charge-lines.ts`: table `charge_lines`
  (migration `20261111222021_charge_lines`, a new table only; `transactions`
  and `credits` are untouched). Every foreign key is `restrict`.
- `src/billing/server/db/billing.ts`: `scopedDb.billing.settleReservation`.
  `captureReservation` and it share one capture (`capture`); every other
  caller's capture is unchanged.
- `src/gateway/charge-lines.ts`: `GATEWAY_PLATFORM_FEE_BPS` (0) and
  `gatewayCharge`, the lines of a charge (basis points in bigint, so exact at
  any safe amount). Pure and client-safe; PR 4 passes
  `appMargin: { bps, payeeOrganizationId }` to add the margin line.
- `src/gateway/server/settle.ts`: `settleGatewayJob` settles the lines, then
  marks the job succeeded at the debit.
- `src/gateway/server/db/gateway-jobs.ts`: `getChargeLines`,
  `recordOutputs`, and the guards below.
- `src/gateway/server/read-job.ts`: `gatewayJobResource`, the document with
  its lines, used by both routes.

### The table

One row per line: `organization_id` (the payer), `transaction_id` (the
`credit_usage` debit), `kind`, `amount_micros` (> 0), `payee_organization_id`
(null is the platform), `gateway_job_id`, `oauth_client_id`, `app_id` (plain
text until PR 3's apps table), `sku`, `created_at`. Indexes: by
transaction; by payer, OAuth client and time (PR 3's monthly cap); by payee
and time (PR 4's earnings); by payer and gateway job (the job document).

### The settle method

`settleReservation(reservationId, lines, { idempotencyKey, description,
metadata, attribution })` runs the existing capture (grow the hold if the
balance covers it, debit `min(remaining, total)`, write the `credit_usage`
row, shrink the hold) and appends one `INSERT … SELECT` per line to the same
`db.batch`. Each line selects from the transaction row this batch inserted,
by its id, and takes `min(amount, debit − lines ahead of it)`; a line with
nothing left is not written. So the lines exist if and only if the debit
does, and always sum to it. A replay of the key writes nothing and returns
the original debit and its lines (`replay: true`). A missing reservation is
`{ ok: false, reason: 'missing' }` and writes nothing. Lines with a zero
amount are dropped before the batch; a negative or fractional amount, or
lines that sum past a safe integer, are refused.

### The hold

The submit holds `gatewayCharge(estimate, GATEWAY_PLATFORM_FEE_BPS)
.totalMicros`, the whole charge on the estimate. The payload snapshots
`estimateMicros`, `platformFeeBps` and `oauthClientId`, so the settle
charges at the fee the hold was taken at and attributes the lines to the
client.

### The job document

`charge` is `{ totalMicros, lines: [{ kind, amountMicros }] }` once the job
succeeded, read through `scopedDb.gatewayJobs.getChargeLines`, which returns
only lines the reading organization paid. `totalMicros` is the debit. A job
that settled with no debit (no hold, or nothing the balance could cover)
reads `{ totalMicros: 0, lines: [] }`; the shortfall is reported.

### A charged job never reads failed

- The run records provenance and then the outputs (`record-outputs`) before
  the charge. The `settle` step charges and marks the job succeeded; a retry
  replays the charge and writes the success again. Nothing runs after it.
- `markFailed` first promotes a job that has charge lines and outputs to
  `succeeded`, at what its lines sum to, and only otherwise marks it failed.
  So an `onFailure` after a charge, or a submit's `NOT_STARTED`, cannot fail
  a charged job.
- A succeeded job with lines always has `costMicros` equal to their sum:
  `markSucceeded` rewrites it from the lines, because a `settle` re-run after
  a first attempt that debited nothing can debit after a top-up.
- The job document shows `outputs` only once the job succeeded: they are
  recorded before the charge.

### A lost trigger reply

`triggerWorkflow` can throw after the instance was created. The submit then
marks the job `NOT_STARTED` and zeroes the hold, but the run still executes
and charges (the capture grows the zeroed hold when the balance covers it).
A row failed with `NOT_STARTED` is therefore still writable by its run:
`markRunning` revives it (clearing the error), and `stampProviderJob`,
`recordOutputs`, `markSucceeded` and `markFailed` accept it. The job ends
`succeeded` with its outputs and lines, or failed with the run's own error.
A replay of its `Idempotency-Key` returns that job.

### Not yet (PR 2)

- A job settled before PR 2 has `costMicros` and no lines; none exist in
  production.
- The fee is off (`GATEWAY_PLATFORM_FEE_BPS = 0`), so no `platform_fee` line
  is written yet.

### For PR 3

The cap counts `sum(amount_micros)` of `charge_lines` for the payer
organization and `oauth_client_id` since the start of the UTC month
(`idx_charge_lines_organization_client_created`), plus the live holds of
that client's jobs. Holds carry no client today: PR 3 either adds the client
to the reservation or sums `credit_reservations` joined to `gateway_jobs`
(`reservation_id`, `oauth_client_id`) for live jobs. The check belongs in
`submitGatewayJob` before `reserveRunCredits`, where the hold amount is
known.

## Not in this stack

- Moving the main app's own workflows onto the gateway. Roughly twenty
  workflows call the provider modules directly today; they move one domain at
  a time once the contract is stable.
- Audio and LLM kinds, result webhooks, streaming.
- Extraction to a separate Worker.
- Cash payouts. They need Stripe Connect and legal review first.
- Reconciled pricing for the native vias. Margin on xAI, Google, Ark and
  ElevenLabs spend rests on the static price cards until that exists.
