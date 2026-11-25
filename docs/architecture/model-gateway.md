# Model gateway

Status: PR 1 (gateway core and app-pays) and PR 2 (charge lines) shipped;
PRs 3–4 are the plan. This
file is the plan and the contract; each PR in the stack updates it to match
what it shipped. § Shipped describes the code as it is.

The gateway is OpenStory's own model API: a proxy under `/api/v1/gateway` in
front of fal, BytePlus, Gemini and Grok. The request body is the provider's
own, unchanged. The job, the price and the result URLs are ours. It runs
inside the main Worker. It is extracted into its own service only after the
contract has held for the main app and for third parties.

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

| Method and path                           | Purpose                                   |
| ----------------------------------------- | ----------------------------------------- |
| `GET /api/v1/gateway/models`              | Every priced model, with its submit path  |
| `POST /api/v1/gateway/{provider}/{model}` | Submit. Returns `202` and the job         |
| `GET /api/v1/gateway/jobs/$id`            | Status, result URLs, the charge (`?wait`) |
| `POST /api/v1/gateway/jobs/estimate`      | Price before submitting (PR 4)            |
| `POST /api/v1/gateway/charges`            | An app's own billing line (PR 4)          |

- **Body in is exact, job out is ours.** The body is the provider's own
  request, checked against the model's input schema on modelschemas.com and
  sent as it is. Each provider queues and polls differently, so the answer is
  one job shape for all of them, and result URLs are our R2 copies.
- `{provider}` is a modelschemas provider id (`fal`, `byteplus`, `gemini`,
  `grok`); `{model}` is that provider's own model id (a fal id keeps its
  slashes). The job is stamped with the provider's `via` at submit and never
  hops between providers.
- **The price is the model's rate card** (modelschemas `pricing`), never the
  provider's billed units. A model with no card, or a request the card cannot
  price, is refused.
- `Idempotency-Key` on submit makes the trigger and the reservation idempotent.
- Results are stored in R2 in the step that generated them (#1645) and
  returned as absolute URLs.
- Every URL anywhere in the body goes through the upload rights check
  (`requireCheckedUploadRights`) before any provider sees it. Inline media
  (`data:` URIs, Gemini `inlineData`) is refused: the check is keyed on a URL.
- OAuth callers need the `models:invoke` scope. `osk_` keys are unscoped.
- Kinds: `image`, `video`, `audio`. LLM calls are a follow-up.

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

- `src/gateway/schema.ts`: the providers and their vias, and the stored
  input, output and error types. Client-safe.
- `src/gateway/server/catalog.ts`: `getGatewayModel` (the model, its input
  schema and its rate card, from modelschemas) and `listGatewayModels`.
- `src/gateway/server/price.ts`: `priceGatewayJob`, the card worked out
  against the request and, at settle, the usage.
- `src/gateway/server/providers.ts`: `GATEWAY_DRIVERS`, one `start`/`poll`
  pair per provider.
- `src/gateway/server/storage.ts`: `storeGatewayOutput`.
- `src/gateway/server/rate-limit.ts`: the per-organization submit limit.
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
- Routes: `src/routes/api/v1/gateway.models.ts`, `gateway.$provider.$.ts`,
  `gateway.jobs.$id.ts`. Thin; the logic is in `src/gateway/server/`.

### Request

```bash
POST /api/v1/gateway/fal/fal-ai/flux/schnell
{ "prompt": "Mara, a ferry mechanic, wipes her hands on a rag in the engine room" }

POST /api/v1/gateway/grok/grok-imagine-video-1.5
{ "prompt": "…", "duration": 6 }
```

- The body is validated with `z.fromJSONSchema` against the model's input
  schema. Where that schema has a `model` property (Grok, BytePlus) the
  path's model is written onto the body; a body naming a different model is
  refused.
- Nothing is defaulted, snapped or renamed: what the provider's schema
  refuses is a `400`, and what it accepts is sent.
- Three refusals keep the price honest (`validatedBody`): on Grok and
  BytePlus, which read the model from the body, the path's model is always
  written there, whatever the schema says; a top-level field the schema does
  not name is refused, not dropped; and a count field (`n`, `num_images`, …)
  above 1 that the card does not price is refused.
- A media string must be a plain `http(s)` URL exactly as sent, or one of our
  own `/r2/` paths. `data:` and `blob:` in any spelling, a protocol-relative
  URL, and any other scheme are refused (`gatedUrls`).

### Models

Every model modelschemas lists for the four providers that has an activity
(`image`, `video`, `audio`), a request schema and a rate card. Since #2432,
only the product's own models (§ The stored snapshot).

Not served, and why:

- **A model whose card needs a number the request does not carry and gives
  no estimate for it.** Flux dev is priced per megapixel of the result,
  Gemini images per token, Seedream per input and generated image. There is
  no honest hold for those, so they are refused at submit until their cards
  carry an estimate.
- **A BytePlus endpoint with no driver.** `catalog.ts` serves only
  `BYTEPLUS_ENDPOINTS`: Ark video tasks, Ark images and Seed Audio
  (`tts/create`). Seed ASR returns text, so it is dropped.
- **A Seed Audio voice cloned from a clip.** The likeness check sees images
  and video; it cannot hear whose voice an `audio_url` is, so a reference
  clip is refused. Stock `speaker` voices and described voices work.
- **Gemini video.** modelschemas lists no Gemini video model.
- **Real people on BytePlus.** The proxy does not register Ark portrait
  assets; an image Ark refuses fails as an Ark error.
- LLM calls: later (§ Not in this stack).

### Job lifecycle

`queued` → `running` → `succeeded` | `failed`. The row is written only
through `scopedDb.gatewayJobs`; it has no selection pointer, so it is a
`claim-discipline` exception like `generated_assets`.

1. **Submit** (`submitGatewayJob`): a known `Idempotency-Key` returns its
   job; else the model is fetched, the body checked against its schema, the
   account against the generation gate, every URL through
   `requireCheckedUploadRights`, the card priced, the row inserted, the hold
   reserved, and the run triggered. The run's payload carries the body, the
   provider endpoint and **the rate card as it read at submit**; the run
   reads no job row and does not fetch modelschemas.
2. **Run:** `start` sends the body. A provider that answers at once (images
   on Grok, BytePlus and Gemini) has its media stored to R2 inside that step
   (#1645). A queued job (fal, Grok and BytePlus video) has its provider id
   stamped on the row, then is polled in batches; the batch that sees it
   finish stores the media. Bytes never cross a `step.do`.
3. **Tail (PR 2):** `record-provenance` (`gateway_job`), then `settle`,
   which records the outputs, prices the card with the usage, charges and
   marks the job succeeded in one step. Nothing runs after it.
4. **Failure:** `onFailure` marks a live row `failed` with
   `{ code, message }` (`CONTENT_REJECTED` for a content refusal, else
   `GENERATION_FAILED`; `NOT_STARTED` is written by the submit when the
   trigger itself failed). The base class zeroes the hold
   (`ownsReservation`). A settled job is never marked failed.

A provider `4xx` is the answer to that body and is not retried; `408`, `429`
and `5xx` retry the step. Unlike Studio, a run does not resubmit after a
content flag or after Ark's InternalServiceError.

### Keys and money

- `platformOnlyCredentials` resolves through `resolvePlatformOptionalKey`
  (`src/models/server/db/api-keys.ts`), which reads env and never the
  organization's key row. The run never touches `scopedDb.credentials`; a
  source test pins that, and `settleGatewayJob` refuses a result that
  reports `usedOwnKey`. The submit's likeness check (`classifyUpload`) runs
  on the platform LLM key too (`withPlatformLlmKey`).
- The hold is `reserveRunCredits(…, { providers: [] })`: no BYOK skip, so an
  organization with its own fal key is still held and charged.
- The hold is the lines of the charge on the card's price for the request,
  at the fee snapshotted on the payload. The charge is the lines on the
  card's price for the request plus the usage the provider reported (BytePlus
  `completion_tokens`, Gemini `usageMetadata`); a card that reads no usage
  charges exactly the hold.
- Seed Audio is BytePlus but not Ark: `voice.ap-southeast-1.bytepluses.com`
  on `SEED_SPEECH_API_KEY`, paced by `acquireSeedSpeechToken` because the
  requests-per-second cap is the account's, shared with character voices.
  Its card holds the 120 second cap ($0.30) and charges the answer's
  `original_duration`.
- The settle is `billing.settleReservation` with the job's `reservationId`
  (PR 2; it was `deductWorkflowCredits` in PR 1), idempotency key
  `${instanceId}:gateway-settle`. When the card refuses the reported usage
  the lines of the estimate (`estimateMicros` on the payload) are charged,
  which is exactly the hold, and reported as a missing cost, never settled
  free. `costMicros` on the row is the debit.
- Insufficient credits at submit is `402 INSUFFICIENT_CREDITS` in the
  `/api/v1` error envelope, and leaves no row, so the same key can be sent
  again after a top-up.

### Idempotency

The `Idempotency-Key` header (≤ 255 characters) is unique per organization
on `gateway_jobs`. The key binds the job; the job binds the rest: the
reservation key is `gateway:<jobId>` and the trigger's `deduplicationId` is
`gateway-<jobId>`. A replay returns the first job only when the provider,
model and body match it (field order aside); a different request under a
used key is a 409 (`requireSameRequest`, at the replay check and in
`holdGatewayJob`). A replay still counts against the rate limit. A key whose first submit was
refused before the hold (credits, a bad upload) is free again. A key whose
trigger failed (`NOT_STARTED`) is spent: retry with a new key.

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

- No estimate endpoint; the hold is not shown before submit.
- The provider's own result object is not returned, only the stored media.
- `MODELSCHEMAS_API_KEY` must be set in production: the anonymous limit is
  60 requests an hour.
- An image the check finds a real person in is refused
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

- The run records provenance, then the `settle` step records the outputs
  before the charge (`finishGatewayRun`), charges and marks the job succeeded; a retry
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

## Shipped (#2431, foundation)

### Usage in the card's names

- **Gemini** reports `usageMetadata` as Google sends it. The evaluator's
  `normalizeUsage` maps it onto the card: `promptTokenCount` to
  `input_tokens`, image tokens (`candidatesTokensDetails`, modality `IMAGE`)
  to `image_output_tokens`, and the rest of `candidatesTokenCount` plus
  `thoughtsTokenCount` to `output_tokens`. The driver does not map it again.
  Checked against Google's page for `gemini-3.1-flash-lite-image`: $0.25 in,
  $1.50 text and thinking out, $30 a million image tokens, "$0.0336 per 1K
  image" (1,120 tokens); the card prices the same (`price.test.ts`).
- **fal** results carry no usage. The driver reports `megapixels`, the sum of
  `width × height / 1,000,000` over the result's `images`, never fal's billed
  units; a result with any image that has no size reports no usage. The
  request is still refused at submit until the card can hold it (#2432):
  this usage prices only the charge.

### Blocked upstream

- **Gemini image models cannot load** (TanStack/schemas#755). The record
  names `v1beta/models/{modelsId}:generateContent` under `image`; modelschemas
  files that schema under `chat`, so its `_links.schema` is a 404 and
  `getGatewayModel` refuses. Not worked around by reading the chat schema.

### Hardening

- **Public error messages.** The job document answers a fixed message per
  code (`GATEWAY_ERROR_MESSAGES`), never the stored text. The row and the
  logs keep the provider's own text.
- **Missing platform key.** The submit refuses with
  `503 PROVIDER_NOT_CONFIGURED` right after the model lookup, before the
  body checks and the hold, when the driver says it cannot run the endpoint
  (`configured` on each driver in `GATEWAY_DRIVERS`). It is the same check the
  run makes: the platform key (`FAL_KEY`, `XAI_API_KEY`, `GEMINI_API_KEY`,
  `ARK_API_KEY`, or the Seed Speech key for `tts/create`) and, for the native
  drivers, the E2E gate.
- **Stuck jobs.** The existing 5-minute cron (`*/5`, the reconcile branch of
  `scheduled()`) also runs `reconcileGatewayJobs`. It takes `queued` or
  `running` jobs with a run id, untouched for 5 minutes, oldest first (100 a
  pass). Each one whose run the engine reports over (errored, terminated, gone
  or complete) is ended as its `onFailure` would have: `markFailed` (a charged
  job still ends `succeeded`), then its hold zeroed, and a warning logged. A
  run still in flight, or one the engine cannot read, is left for the next
  pass. A job whose run id was never recorded (`attachRun` failed and the run
  died) is not swept.

### Real jobs (2026-11-26)

One HTTP job per provider on `bun dev` with an `osk_` key: submit, `GET
/api/v1/gateway/jobs/$id?wait`, then the hold, the lines against the debit
and the R2 output read back.

| Model                                            | Hold     | Charge    | Output    |
| ------------------------------------------------ | -------- | --------- | --------- |
| `grok-imagine-image`                             | $0.02    | $0.02     | JPEG, 200 |
| `grok-imagine-video-1.5-lite` (2 s)              | $0.04    | $0.04     | MP4, 200  |
| `seed-audio-1.0`                                 | $0.30    | $0.0152   | WAV, 200  |
| `seedance-1-0-pro-fast-251015` (480p, 16:9, 2 s) | $0.01944 | $0.019845 | MP4, 200  |

The lines summed to the debit on every job. Seedance charged 2% above its hold
(Ark's `completion_tokens` beat the card's estimate); the capture grew the
hold. Seedance holds only when the body carries `ratio`, `duration` and
`resolution`, the card's estimate inputs; without `ratio` it is refused.

Refused at submit, as they should be until #2432 or upstream:

- `seedream-5-0-lite-260128`: `generated_images` is a usage lever with no
  estimate.
- `fal-ai/flux/schnell`: `megapixels` is a usage lever with no estimate.
- `gemini-3.1-flash-lite-image`: `404 Unknown model`, the schema link
  (TanStack/schemas#755).

## The `openstory` adapter (#2433)

### Spike: how a TanStack AI adapter carries a provider's body

Read against `@tanstack/ai` 1.4: `ImageAdapter.generateImages`,
`AudioAdapter.generateAudio` and `VideoAdapter.createVideoJob` /
`getVideoStatus` / `getVideo`, and how `@tanstack/ai-fal`, `-grok`, `-gemini`
and `-byteplus` fill them. Each provider adapter builds its provider's body
from `prompt`, `size`, `duration`, `numberOfImages` and `modelOptions`.

**Decision.** One `openstory` adapter per kind. `modelOptions` is the
provider's own body, built by the product's existing builders, and is sent
as it is. The video shape maps onto a gateway job one to one:
`createVideoJob` is the hold and the start, `getVideoStatus` is one poll,
`getVideo` returns the stored URL. The product already calls
`generateVideo` in one step and `getVideoJobStatus` in its poll steps, so a
call site changes its adapter and nothing else.

**What does not fit:**

- `prompt`, `size`, `duration` and `numberOfImages` are TanStack's own
  normalised fields. The gateway never builds a body, so the adapter refuses
  `size`, `duration` and `numberOfImages`, and never writes `prompt` onto
  the body; the prompt lives in the body under the provider's own name.
- `getVideo` returns a URL. The gateway hands the media to the caller's
  `store` in the poll that saw the job finish (#1645), so `getVideo` returns
  that stored URL; there is no provider URL to fetch twice.
- A TanStack job id is one string. The in-process job id carries the
  gateway job id, the provider's job id and the hold, so a poll reads no row.
- Rate cards, holds and usage have no place in the adapter interfaces; the
  adapter returns `usage` only as TanStack's `TokenUsage` where it already
  matches, and the charge stays on the gateway job.

### Phases

The run of a held job is functions a caller runs in its own steps
(`src/gateway/server/phases.ts`): `startGatewayRun`, `pollGatewayRun`
(one poll), `settleGatewayRun`, `finishGatewayRun` (outputs, then the
charge: the one place that order lives) and `releaseGatewayRun` (zero the
hold, then `markFailed`, for a run that failed). The hold is `holdGatewayJob`
(`submit-job.ts`), given the resolved model: the platform key, the body, the account, every
URL, the price, the row and the reservation, returning the `GatewayRun`
snapshot. `submitGatewayJob` is the public caller (replay, hold, trigger);
`GatewayGenerationWorkflow` runs the phases in its steps; `record-outputs`
folded into `settle`, so a replay re-records the same outputs. Each phase stores media through a `GatewayStore` the caller
passes, inside the step that received it.

### The adapter

`src/gateway/server/adapter/index.ts`: `openstoryImage`, `openstoryVideo`
and `openstoryAudio` (TanStack `BaseImageAdapter`, `BaseVideoAdapter`,
`BaseAudioAdapter`, `name: 'openstory'`), each over a `GatewayTransport`:
`submit(body, idempotencyKey)` holds and starts, `poll(handle)` polls once.
The transport is stateless and may be reused; the key is required on each
adapter (`openstoryImage(model, transport, { idempotencyKey })`), which is
built per call. A video poll step builds `openstoryVideoStatus(model,
inProcessPoller({ scopedDb, store }))`: a `GatewayPoller` needs no model,
key or rights. That type pair is the one seam; `inProcessGateway`
(`adapter/in-process.ts`) is the transport today and the HTTP transport
(#2438) is the other.

- **In-process.** `submit` runs `holdGatewayJob` on the caller's
  `WorkflowScopedDb` with the model it snapshotted at the trigger (schema and
  card are never fetched mid-run), records the caller's run id on the job
  (the stale-job sweep reads it), starts, and for an answer at once stores
  and settles. A queued job's id is a handle carrying the held run and the
  provider's job id. The poll that sees the job finish stores it through the
  caller's `store` and finishes it (`finishGatewayRun`); a failed job is
  released (`releaseGatewayRun`). A poll first reads its own job by id
  (`scopedDb.claims.gatewayJobs.getById`): a job that already ended answers
  from the row, so a retried poll never stores a second copy or charges
  again. A job whose caller died is ended by the sweep.
- **The video job id** is the whole held `GatewayRun` as JSON, so a poll
  step needs nothing else. That contract changes in #2438: the HTTP
  transport hands out an opaque id, so a caller must not read the id.
- **A succeeded job with no outputs** throws; it never answers with zero
  media.
- **An orphaned object.** A poll that stores the media and then fails to
  finish leaves its R2 object; the retry answers from a fresh store or the
  row, so at most one object is orphaned and the job is charged once.
- **The body is `modelOptions`.** TanStack's `prompt` is required by its
  types and ignored here; pass `''`. `size`, `duration` and
  `numberOfImages` are refused: put them in the body.
- **Replays.** A held job that already exists is never started twice: a
  succeeded one returns its stored outputs, a failed one its error, a running
  one resumes polling its stamped provider job, and a running one with no
  stamp (the provider may have it) is failed and its hold let go. Only a
  queued job starts, and only the attempt whose `markRunning` flipped the
  row. So a transient start error (a dropped connection) fails the job
  closed on the retry rather than risk sending it twice.
- **Idempotency.** The caller passes a replay-stable key per call (say
  `${instanceId}:${stepName}`, plus the variant's index in a fan-out). A
  key reused with a different body is refused (`holdGatewayJob`, a 409 on
  the public endpoint), so it never answers with another call's job. A
  retried step, on the same transport object or a new one, finds the same job and the
  same hold (`gateway:<jobId>`), and the settle key is `gateway:<jobId>:settle`,
  so a generation is charged once however often a step runs.
- **Images and audio** submit and poll to the end inside one call. **Video**
  maps onto `generateVideo` and `getVideoJobStatus` across the caller's steps.
- **Refusals** (body, price, credits, missing key, a key reused for
  another body) are `NonRetryableError`:
  the step does not retry the answer.

### Trusted callers

The public endpoint refuses inline media and runs the likeness check on every
URL. `holdGatewayJob` takes `rights`: either `{ scopedDb, request }`, which
runs those checks, or `UPLOAD_RIGHTS_CHECKED`, a unique symbol an in-process
caller passes to say it ran `requireUploadRights` before the run (Gemini
stills go inline by design, `geminiStillSource`). A JSON body cannot carry a
symbol, and `submitGatewayJob` always passes the request, so the public
endpoint can never skip the checks. `inProcessGateway` requires the symbol
as a named argument; nothing defaults it. With it the gateway checks no URL
and refuses no inline part, so the caller owns `requireUploadRights` for
every URL and every inline part it sends. `upload-rights-checked.test.ts`
resolves every value import, re-export and dynamic import of `submit-job.ts`
and fails unless the file reaching the symbol is on its allowlist, and fails
if an allowlisted file passes it on. `in-process.ts` only takes its type;
the Models page run (`asset-generation-workflow.ts`) is the one caller. A
new caller is added there on purpose, and no route or MCP tool may be.

### Billing handover

A call through the adapter is held by `holdGatewayJob` and charged by
`settleGatewayRun`, never by `deductWorkflowCredits`, `requireCredits` or
`reserveRunCredits`; the hold is `billing.createReservation` with no own-key
skip. `adapter/in-process.test.ts` fails if a generation is charged twice
(a retried step, a replayed poll) or zero times, or if the wallet drops by
anything but the charge.

### The Models page

`createGeneratedAsset` (`src/models/server/generated-assets.ts`) picks the
route once, at the click, and puts it on the payload:

- **`openstory`** (every provider, no own fal key): `holdGatewayJob` with
  the request's likeness check, under the key `asset:<assetId>`. The
  `generated_assets` row is stamped `provider: 'openstory'` and
  `gatewayJobId`; the charge is that job's, shown under the run once it
  settles (`getGeneratedAssetWithCharge`). `AssetGenerationWorkflow` runs
  the adapter over `inProcessGateway` with the same key, so the run finds
  the click's job and hold rather than making new ones.
- **`fal`** (the organization has a usable fal key): today's direct path,
  unbilled. Schema check, account check and likeness check at the click, no
  hold, no gateway job. The run uses the fal driver with the organization's
  key and fails rather than spend the platform's.

The page lists Grok, BytePlus and Gemini models beside fal. A model the
gateway cannot run is shown with the reason: no request schema, no price, or
a usage lever with no estimate (`unholdableReason`, "No price yet for this
model", until #2432). A fal model the gateway cannot hold still runs on an
own fal key; the detail page reads `hasFalKey` from the billing gate query
and, without one, shows the model unavailable rather than fail at the click.
A run's kind is the model's (`model.kind`), never the client's `activity`,
and a failed run lets the click's hold go (`releaseGatewayRun` in
`onFailure`).

The model list carries a price summary, not the card, so the list marks only
a model with no schema or no price; the detail page reads the card and says
when it has no price yet.

Run on `bun dev` (2026-11-26) through `createGeneratedAssetFn` with a
session, one each:

| Model                                            | Hold     | Charge   | Output    |
| ------------------------------------------------ | -------- | -------- | --------- |
| `grok-imagine-image`                             | $0.02    | $0.02    | JPEG, 200 |
| `seedance-1-0-pro-fast-251015` (480p, 16:9, 2 s) | $0.01985 | $0.01985 | MP4, 200  |

One gateway job, one hold and one debit each; the lines summed to the debit.
`fal-ai/flux/schnell` was refused at the click with the card's reason and
`gemini-3.1-flash-lite-image` as an unknown model (TanStack/schemas#755).

`AssetGenerationWorkflow` is kept, not deleted as #2433 planned: it is the
adapter's first product caller and the own-key path needs a run too.
`extractAssetOutputs` moved to `providers.ts`, `outputExtension` and the
bucket map to `storage.ts`, `isFalValidationError` to `src/models/fal-error.ts`.

## Every model can be priced (#2432)

### The stored snapshot

The gateway reads a model, its request schema and its rate card from
`gateway_models` (`src/platform/server/db/schema/gateway-models.ts`), never
from modelschemas on a request.

- `getGatewayModel` answers from the stored row only. A model not stored is
  `404 Unknown model`; a request never asks modelschemas and never writes a
  row, so a caller cannot grow the table by inventing ids. A modelschemas
  outage stops nothing the snapshot holds (`catalog.test.ts`, "serves a
  stored model with modelschemas unreachable").
- **The gateway serves the product's models.** The snapshot holds exactly
  `productGatewayModels()` (`src/gateway/product-models.ts`), and
  `GET /api/v1/gateway/models` lists the snapshot. Serving another model is
  adding it there.
- The Models page browses every modelschemas model, so it reads one the
  snapshot lacks live (`getBrowsableGatewayModel`), through the catalog's
  bounded TTL cache as the fal detail page always has, and keeps nothing.
- `refreshGatewayModels` (`src/gateway/server/refresh-models.ts`) re-reads
  every product model under a 5 minute budget. Rows are keyed by the model's
  own id: one modelschemas answers under another id is dropped, as is a model
  it refuses and a row no longer in the product list. An outage, a rate limit
  or the budget keeps the stored row; a run that could read nothing throws.
- It runs on the existing daily cron (`FAL_PRICING_CRON`), before the fal
  pricing refresh and in its own `try`, so a failure or the budget never
  stops fal pricing; no new cron expression. `bun scripts/refresh-fal-pricing.ts`
  runs both against local D1. Set `MODELSCHEMAS_API_KEY`: a refresh is two
  requests a model, past the anonymous 60 an hour.
- The fal pricing refresh takes its cards from this snapshot
  (`listStoredGatewayModels(db, 'fal')`); its own modelschemas fetcher
  (`fetch-rate-cards.ts`) is gone. `model_pricing.rate_card` keeps the card it
  had when the snapshot has none.
- Why a table of its own: a `model_pricing` row is a fal unit price keyed by
  unit, with a required price; a gateway model is keyed by provider and model
  id and carries a schema. One row is the whole `GatewayModel`, parsed on
  read, so a row an older deploy wrote is checked, not trusted.
- The Models page lists still read modelschemas: an outage hides those
  lists, not generation.

## Not in this stack

- Moving the main app's own workflows onto the gateway. Roughly twenty
  workflows call the provider modules directly today; they move one domain at
  a time once the contract is stable.
- LLM calls, result webhooks, streaming.
- Extraction to a separate Worker.
- Cash payouts. They need Stripe Connect and legal review first.
- Reconciling the rate cards against provider bills. The charge is the card;
  a wrong card is our loss or the caller's until that exists.
