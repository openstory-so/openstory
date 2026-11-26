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
  not name is refused, not dropped; and a count field (`COUNT_FIELDS` in
  `price.ts`) above 1 that the card does not price is refused, as is one
  above 1 at any depth below the top level, and any count at any depth that
  is not a whole number of at least 1. A count is a number or string, never
  an object, and nothing under a JSON Schema keyword (`properties`,
  `examples`, `default`, …) is read as one, so a tool or response schema
  with a property named `n` passes.
- On a card priced from the request alone, only as many outputs as the
  request's count (else one) are stored and charged; extras a model returns
  are dropped with a warning. A card that charges each output from usage
  (an output lever: output tokens, megapixels, seconds, generated images)
  keeps and charges every output it returns; an input-only usage lever does
  not count (`heldResult` in `phases.ts`).
- A media string must be a plain `http(s)` URL, or one of our own `/r2/`
  paths. It must read back from the URL parser as written, up to scheme and
  host case, the root slash and percent-encoding; the parser's href is what
  the likeness check sees, and the body goes to the provider as sent.
  Anything a parser would still fetch is URL-like and checked: `https:host`,
  `https:/host`, backslashes, a leading control character, a tab, LF or CR
  inside an `http`, `https` or `ftp` URL (the parser drops them), a default
  port, a dot segment. `data:` and `blob:` in any spelling, a
  protocol-relative URL, and any other scheme written with `//` are refused
  (`gatedUrls`). Prose is not: `http: the old protocol` (no host follows the
  scheme) and `Label:\n//note` (another scheme, tested as written).

### Models

Every model modelschemas lists for the four providers that has an activity
(`image`, `video`, `audio`), a request schema and a rate card.

Not served, and why:

- **A model whose card needs a number the request does not carry and gives
  no estimate for it.** There is no honest hold for those, so they are
  refused at submit until their cards carry an estimate (below).

### Product models that cannot be held (#2432)

`bun scripts/check-gateway-coverage.ts` prices two bodies for every model the
product uses (`productGatewayModels()`) against its card: a typical request
(the card's own example) and, where a builder is wired
(`coverage-bodies.ts`: fal stills and motion, native Grok video), the body
the product sends. On the recording: 43 of 76 hold a typical request; 23 of
57 hold the product's body. The 19 with no builder in the check (pinned
in `coverage.test.ts`): the fal routes the product's builders never pick
(`fal/xai/grok-imagine-video/v1.5/text-to-video`,
`fal/xai/grok-imagine-video/v1.5/reference-to-video`,
`fal/fal-ai/kling-video/v3/pro/text-to-video`), audio and lip-sync
(`fal/fal-ai/ace-step-1.5`, `fal/fal-ai/ace-step/prompt-to-audio`,
`fal/fal-ai/sync-lipsync/v3`, `byteplus/seed-audio-1.0`,
`elevenlabs/music_v2_5`), Ark
(`byteplus/dola-seedream-5-0-pro-260628`,
`byteplus/dreamina-seedance-2-0-260128`,
`byteplus/dreamina-seedance-2-5-260628`,
`byteplus/dreamina-seedance-2-0-mini-260615`), Grok stills
(`grok/grok-imagine-image-2.0`, `grok/grok-imagine-image-quality`) and
Gemini (`gemini/gemini-nano-banana-2.1`, `gemini/gemini-3.1-flash-image`,
`gemini/gemini-3.1-flash-lite-image`, `gemini/gemini-3-pro-image`,
`gemini/gemini-omni-1.2-flash`). `--json` prints
`{ provider, id, holdable, reason, product, productReason }` for each, and
`--recorded` reads
`src/gateway/server/coverage.fixture.json` (recorded 2026-11-26) with no
network. `coverage.test.ts` fails when a gap is not listed here with its
upstream issue. Each stays refused until its card is
fixed upstream; no local estimate, sibling price or guess stands in.

- `fal/fal-ai/flux-2`, `fal/fal-ai/flux-2/flash`, `fal/fal-ai/flux-2/turbo`,
  `fal/fal-ai/hidream-i1-full`, `fal/fal-ai/hunyuan-image/v3/text-to-image`,
  `fal/fal-ai/hunyuan-image/v3/instruct/edit`, `fal/krea/v3/text-to-image`,
  `fal/krea/v3/edit`, `fal/fal-ai/krea-2/turbo`: `megapixels` has no
  estimate. TanStack/schemas#759
- `fal/google/nano-banana-2.1`, `fal/google/nano-banana-2-lite`,
  `fal/google/nano-banana-lite/edit`,
  `fal/openai/gpt-image-2.6/flare/text-to-image`,
  `fal/openai/gpt-image-2.6/flare/edit`, `fal/google/nano-banana-2.1/edit`:
  token levers with no estimate (a hold of $0, or required).
  TanStack/schemas#760
- `byteplus/dola-seedream-5-0-pro-260628`: `input_images` and
  `generated_images` have no estimate. TanStack/schemas#761
- `fal/fal-ai/ace-step/prompt-to-audio`: `seconds` has no estimate.
  TanStack/schemas#762
- `fal/bytedance/seedance-2.0/enterprise/v2/text-to-video`,
  `fal/bytedance/seedance-2.0/enterprise/v2/image-to-video`,
  `fal/bytedance/seedance-2.0/enterprise/v2/reference-to-video`,
  `fal/fal-ai/ace-step-1.5`: no model row. `fal/fal-ai/qwen-image-2/pro/text-to-image`,
  `fal/fal-ai/qwen-image-2/pro/edit`: no rate card. TanStack/schemas#763
- `gemini/gemini-nano-banana-2.1`, `gemini/gemini-3.1-flash-image`,
  `gemini/gemini-3.1-flash-lite-image`, `gemini/gemini-3-pro-image`: the
  request schema does not load. TanStack/schemas#755
- `byteplus/dreamina-seedance-2-0-260128`,
  `byteplus/dreamina-seedance-2-5-260628`,
  `byteplus/dreamina-seedance-2-0-mini-260615`: `input_video` has no
  estimate. TanStack/schemas#764
- `fal/fal-ai/sync-lipsync/v3` (`minutes`), `gemini/gemini-omni-1.2-flash`
  (`input_tokens`): usage-only cards with no estimate. TanStack/schemas#765
- `elevenlabs/music_v2_5`: no rate card. The only ElevenLabs model the
  gateway serves (`ELEVENLABS_GATEWAY_MODELS`); voice design, dialogue and
  speech-to-speech stay direct. TanStack/schemas#756

Holdable on a typical request but refused when the product sends a field the
card types differently from the schema (TanStack/schemas#766):
`fal/xai/grok-imagine-video/v1.5/image-to-video` (`image_url`),
`fal/fal-ai/kling-video/v3/pro/image-to-video` (`generate_audio`),
`fal/minimax/h3-max/image-to-video`, `fal/minimax/h3-max/text-to-video` and
`fal/minimax/h3-max/reference-to-video`
(`resolution` case). `grok/grok-imagine-video-1.5` holds on `duration` alone,
at the 480p rate (TanStack/schemas#767). Text cards have no service-tier
lever (TanStack/schemas#768). Outside the gateway's providers:
ElevenLabs (TanStack/schemas#756, TanStack/schemas#757) and the Grok image
edits endpoint (TanStack/schemas#758).

Holdable on a typical request but refused on the product's body because the
card lists fewer values than the schema accepts (TanStack/schemas#769):
`fal/fal-ai/nano-banana-pro`, `fal/fal-ai/nano-banana-pro/edit` (`2K`),
`fal/xai/grok-imagine-image/v2.0/text-to-image`,
`fal/xai/grok-imagine-image/v2.0/edit`,
`fal/xai/grok-imagine-image/quality/text-to-image`,
`fal/xai/grok-imagine-image/quality/edit` (`2k`),
`fal/bytedance/seedream/v5/pro/text-to-image`,
`fal/bytedance/seedream/v5/pro/edit`, `fal/fal-ai/flux-2/flash/edit`
(`image_size` presets).

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
2. **Run:** `start` claims the row (`markRunning`) and sends the body; a
   replayed `start` that finds the row already `running` fails and releases
   rather than send again (`claimAndStartGatewayRun`, shared with the
   in-process transport). A provider that answers at once (images
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

A start's error follows one rule, in § Audio on the gateway (the start-error
paragraph): only a start the provider answered without running is sent
again. Unlike Studio, a run does not resubmit after a content flag or after
Ark's InternalServiceError.

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
- `GATEWAY_RATE_LIMITER` (300 submits a minute per organization since #2438, namespace
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

A run that already holds credits for its work (motion, studio video) passes
its reservation as `inProcessGateway({ reservation: { id } })` (#2435). The
hold still prices the card and refuses what it cannot price, and still
writes the job row, but takes no second reservation: the settle captures
the card's charge against the run's, under the same `gateway:<job>:settle`
key, so a balance that covers the run is not asked to cover the job again.
Such a run carries `ownsReservation: false`: a failed job is marked failed
without zeroing the run's reservation, and the job row records no
reservation, so the stale-job sweep cannot zero it either. Only an
in-process caller can pass one; the public submit always holds its own
(`runReservationId: null`), and the Models page passes none.

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

## Product stills on the gateway (#2434)

Any still whose endpoint the gateway can hold goes through it, on any via:
the body is the one the product's own builder makes for that via (the fal
builders, native Grok), and the generation and edit endpoints are judged
each on their own body.

The trigger decides the route and puts it on the payload as
`gatewayRoutes` (`imageGatewayRoutes`, `src/stills/server/image-gateway-routes.ts`).
`imageRouteTargets` lists every image model the product can select, through
`resolveImageVia`, the same function the direct path uses:

- `xai` (native Grok): the xAI model id.
- `fal`: the text-to-image endpoint and its edit endpoint (`EDIT_ENDPOINTS`),
  two targets, so a still with references is decided on the edit card.
- `byteplus` (Ark Seedream) and `google` (native Gemini): no target, so the
  run finds no route and goes direct ("not routed at the trigger"). For Ark
  this is an explicit rule, not the body check: Ark registers a real
  person's portrait as an account-wide asset before the call, which the
  product owns (`byteplus-ark.md`). The Ark card is also unholdable today
  (`input_images` required).

Each target goes through `resolveGatewayRoute`: own key for the provider is
direct, a snapshot miss is direct (`getSnapshotGatewayModel`, so a
modelschemas outage cannot stop a trigger), a provider with no platform key
on this server (`GATEWAY_DRIVERS[provider].configured`) is direct, an
unholdable card is direct. The run reads its route only through
`gatewayRunRoute`, the snapshot plus the pure body check, so a step retry
takes the same route. A run triggered before #2434 has no routes and stays
direct. `generateImageWithProvider` is the one place the route is applied
(`gatewayImageRequest`): an `openstory` route plus a body the endpoint takes
(`gatewayCannotRun`) runs the `openstory` adapter over `inProcessGateway`;
anything else goes direct as before.

- Each attempt is its own job and hold: the idempotency key is
  `<runId>:<stepName>`, and the softening loops name a step per attempt.
  The fal content-flag rescue to `IMAGE_CONTENT_FALLBACK_MODEL` is a new
  attempt on another model, so its route is decided again for that model.
- A provider refusal is a 4xx: the hold is released, the job is
  `CONTENT_REJECTED`, and the message reaches `isContentRejectionError`
  unchanged, so softening runs as before.
- An `openstory` still is charged by the gateway; the workflows skip their
  image `deductWorkflowCredits` on that via. Studio takes no trigger hold for
  it.
- References: a fal body carries URLs. Before sending, a local `/r2/` URL is
  made fetchable with the platform fal key (`ensureExternallyFetchableUrls`),
  as the direct path does; xAI gets a data or CDN URL (`toDataOrCdnUrl`).
  The job is held, checked and replayed on a body whose stored URLs are
  absolute and the same on every attempt (`stableMediaBody`: the CDN URL,
  else the app's own `/r2/` route), so a `format: uri` field validates (no
  snapshot schema declares one today). The fal upload is `wireBody`
  (`fetchableFalBody`), made just before the hold so a failing upload
  strands no hold. Both rewrite only a URL we serve ourselves (`/r2/<key>`
  or the app's origin) whose key the run's organization owns
  (`storedUrlOwnedBy`, the check `isCheckable` uses); another host with an
  `/r2/` path, or another organization's object, is sent as it came, never
  turned into a CDN URL or an upload. The direct send knows no organization
  and checks the host only. `ensureExternallyFetchableUrl` itself still
  takes any host's `/r2/` path, as on main. Without a storage CDN (Deploy-button
  workers, e2e record) each fal upload is a new URL, so holding the sent
  body would make a retried step conflict with its own job after it was
  charged. Video does the same: the motion and Studio fal builders keep the
  stored URLs, the direct send uploads them in its fetch
  (`fetchableFalFetch`), and `sendVideoJob` holds the stored body. xAI data
  URIs, Ark asset ids and Seed's inline audio do not change between
  attempts.
- Rights: the step passes `UPLOAD_RIGHTS_CHECKED`. A still's references are
  uploads classified when saved (`requireUploadRights` in `media-upload.ts`,
  location and element attach, describe upload), Studio uploads checked at
  the click (`requireCheckedUploadRights` in `create-studio-asset`), or media
  we generated (sheets, earlier stills), which is never classified. An
  upload saved before the ledger (#1581) has no verdict: the gateway step
  refuses it (`requireUploadRights` on `needsLikenessCheck` refs). The
  direct path still sends it unchecked (#2439).

Routed today, when the snapshot holds the card and the body passes:

| Still                                   | Generation                                | With references                                                                                            |
| --------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Grok Imagine 2.0 / Quality (native xAI) | gateway                                   | direct: no `v1/images/edits` card ([TanStack/schemas#758](https://github.com/TanStack/schemas/issues/758)) |
| Phota                                   | gateway (proved)                          | gateway, `fal-ai/phota/edit` (proved)                                                                      |
| Nano Banana 2 (retired; old sequences)  | gateway (body checked on the real schema) | gateway (`/edit`, same)                                                                                    |
| Nano Banana Pro                         | by the body check (card holdable)         | by the body check                                                                                          |
| Seedream 5 Pro on fal (no Ark key)      | by the body check                         | by the body check                                                                                          |

Stay direct, with the reason:

- FLUX.2 Max: the product's body sends `num_images`, which the schema does
  not have (`gatewayCannotRun`).
- Megapixel cards, no estimate before the run (#2432): FLUX.2 dev text-to-image,
  FLUX.2 flash and turbo, HiDream, Hunyuan (and its edit), Krea (and its edit).
- Token cards (#2432): Nano Banana 2.1 and its edit, Nano Banana 2 Lite and
  its edit, GPT Image 2.6.
- No card: Qwen Image 2 Pro.
- Gemini native: TanStack/schemas#755. Ark Seedream: the rule above.
- Upscales, sheet portraits that edit, posters.

Proof (2026-11-26, `bun dev` on port 3004, Studio through MCP):

- Grok 2.0, no references: one hold of $0.06, one `credit_usage` of $0.06
  (`gateway:<job>:settle`), no other debit, output in R2.
- Phota, no references: job `fal-ai/phota`, $0.09, one settle line, no
  other debit; quote $0.09.
- Phota with one uploaded reference: job `fal-ai/phota/edit`, the reference
  sent as a fal storage URL, $0.09, one settle line; quote $0.09. The upload's
  likeness check ($0.008) is the upload's own line.
- The local snapshot was seeded by model when the anonymous modelschemas
  limit (60 an hour) refused the full refresh: `fetchGatewayModel` then
  `storeGatewayModel` for each id against local D1, the two calls the
  refresh makes.

Children: Studio images; shot image and variant regenerations; character
and location sheet regenerations; the sequence pipeline (storyboard and
continue, Update stale, smart retry, add model), each child inheriting
`gatewayRoutes` from its parent like `reservationId`. A root merges its
image routes into any it was given (`{ ...input.gatewayRoutes, ...image }`).
These carry no routes and go direct: Recast location's `RegenerateShots`
children, shot previews and Replace element's children.

Quotes: `imageQuotePricing` gives a trigger the fal map with each endpoint
on an `openstory` route carrying `gatewayHolds`: the hold
(`gatewayHoldMicros` of its card on the product's real body) per shape,
keyed `gatewayHoldKey(aspectRatio, resolution, numImages)`, for every aspect
ratio, resolution and count up to 4, the generation endpoint with no
references and the edit endpoint with one. `estimateImageCost` reads the
hold for the request's shape; a shape with no hold runs direct and keeps the
fal price. So quote equals hold for every routed still. An endpoint with no
fal row is never given one: its quote is refused on either route, as
before. Keys are read once per provider and a snapshot model is parsed once
per isolate, so a quote's few thousand shape checks stay cheap. Signed-in pages read the same map
through `getOrganizationFalPricingFn` (`useOrganizationFalPricing`): Studio,
the character and location sheets, the scene list and the shot prompts. The
public `getCatalogFalPricingFn` is for signed-out pages only.

No double hold: a run that owns a reservation (the pipeline envelope, a
shot or sheet trigger) passes it as `runReservationId`, and the gateway job
charges that reservation instead of holding its own. A run with none (Studio
on the `openstory` route) holds per job.

Known differences from direct:

- A transient provider 5xx fails an `openstory` still, also on a queued
  fal start; the direct path retried it.
- `openstory` fal stills write no `model_usage_observations`, so they no
  longer feed the medians direct fal quotes read.
- A still is written to R2 twice: the gateway stores its output under
  `gateway/<id>/`, then the step copies it to the still's own key. The
  product's store callbacks take a URL, not media, so passing the final key
  into the transport changes every still's store; the gateway copy stays as
  the job's output record.
- Every quote reads the same map: preflight, Continue, Update stale, smart
  retry, sheet references and the freeze-plan gate (from the payload's
  routes, no read), so the run envelope reserves what the gateway charges.
- A quote that knows its references passes `edit`: shot image, variants
  (always an edit of the current still), smart retry, add model per shot,
  Studio, and the sheet pages. Update stale's floor takes the cheaper of the
  two. Plan envelopes (storyboard, Continue, freeze-plan) price every still
  with no references, because which shots carry references is not known per
  unit; where the generation hold is the higher (Grok: $0.06 against a
  direct $0.04 edit), a cast-heavy plan reserves more than it spends and
  settle releases the rest.

## Every model can be priced (#2432)

### The stored snapshot

The gateway reads a model, its request schema and its rate card from
`gateway_models` (`src/platform/server/db/schema/gateway-models.ts`), never
from modelschemas on a request.

- **Product models are served from the snapshot; anything else is a live
  read and fails when modelschemas is down.** `getGatewayModel` answers from
  the stored row; on a miss it reads modelschemas through the catalog's
  bounded TTL cache, writes nothing, and refuses an answer under another id
  than the one asked for. Only the scheduled refresh writes rows, so a caller
  cannot grow the table by inventing ids (`catalog.test.ts`). Live reads
  spend the refresh's modelschemas quota, so they are bounded per isolate: a
  refused id is remembered for ten minutes, and past 30 live reads a minute
  the answer is `429 RATE_LIMITED`.
- The snapshot holds exactly `productGatewayModels()`
  (`src/gateway/product-models.ts`). `GET /api/v1/gateway/models` and the
  Models page lists still read modelschemas' lists.
- `refreshGatewayModels` (`src/gateway/server/refresh-models.ts`) re-reads
  every product model under a 5 minute budget, each request cut off at 30
  seconds (`fetchCatalogJson`). Rows are keyed by the model's own id. Only a
  row no longer in the product list, or whose key is not its model's id or
  that no longer parses, is dropped (by the row's key). A refusal, an answer
  under another id, an outage, a rate limit or the budget keeps the stored
  row and logs an error, so a bad modelschemas deploy cannot empty the
  snapshot; a run that could read nothing throws.
- It runs on the existing daily cron (`FAL_PRICING_CRON`), before the fal
  pricing refresh and in its own `try`, so a failure or the budget never
  stops fal pricing; no new cron expression. `bun scripts/refresh-fal-pricing.ts`
  runs both against local D1. `MODELSCHEMAS_API_KEY` is required in
  production (`scripts/push-secrets.ts`): a refresh is two requests a model,
  past the anonymous 60 an hour, and a production refresh without it logs
  an error.
- The fal pricing refresh takes its cards from this snapshot
  (`listStoredGatewayModels(db)`); its own modelschemas fetcher
  (`fetch-rate-cards.ts`) is gone. A used fal endpoint the snapshot does not
  hold (no request schema, or not a product model) keeps the card it had on
  `model_pricing.rate_card`, and the refresh logs it as a warning. The card is
  stored twice (`gateway_models.model.card` and `model_pricing.rate_card`)
  until the estimate readers move to the snapshot (#2439).
- Why a table of its own: a `model_pricing` row is a fal unit price keyed by
  unit, with a required price; a gateway model is keyed by provider and model
  id and carries a schema. One row is the whole `GatewayModel`, parsed on
  read, so a row an older deploy wrote is checked, not trusted.
- The lists read modelschemas: an outage hides them, and stops generation
  for every model outside the snapshot.

## Motion, studio video and lip-sync (#2435)

### One path

`src/motion/server/video-job.ts` is the one send, poll and price path for
motion and studio video; `pollMotionJob`, `pollStudioVideoJob`,
`motionCostFromUsage` and `studioVideoCostFromUsage` are gone.

- **Route in its own step.** Motion has six triggers and a content-flag
  rescue that swaps the model mid-run, so the route is resolved in the run,
  not on the payload: `route-motion<tag>` (studio `route-video<tag>`) runs
  after the via step, before the submit. Its target is a pure function of
  the via and the request (`motionGatewayTarget`, `studioGatewayTarget`; the
  submit uses the same endpoint helper), and `routeVideoJob` asks
  `resolveGatewayRoutes` with the own-key check through
  `scopedDb.liveRead.apiKeys.hasUsableKey` and the stored snapshot. The
  step's checkpoint (the route, the model as JSON text) is what every retry
  of the submit reuses. The submit captures the body the provider adapter
  would send (its one request, intercepted; nothing leaves) and applies
  `gatewayRunRoute`: the pure schema and card check, no read. A submit
  whose target is not the routed one goes direct (`not routed at the
  trigger`). A rescue gets its own `-rescue` route step for the new model
  and its own submit key, so it never reuses a job stamped for the old one.
- **The run's reservation.** The submit passes the run's `reservationId`
  (`inProcessGateway({ reservation })`), so the gateway charges the
  reservation the trigger already took instead of holding a second time; a
  run with none holds per job, as the Models page does.
- **`openstory`:** the same body through `openstoryVideo` over
  `inProcessGateway`, key `<run>:submit-motion<tag>` (studio
  `submit-video<tag>`). The job is stamped `via: 'openstory'`.
- **Direct:** own key, a model or body the gateway cannot hold, an Ark draft
  or its final (Ark task ids the gateway does not hand out; `isArkDraftTask`,
  one rule for motion and studio: a draft flag on a model without draft mode
  is ignored and routes as usual), and scripts.
  The reason is logged (`Video job routed direct`).
- **Poll follows the stamp.** `openstory` polls `openstoryVideoStatus` over
  `inProcessPoller`; the poll that sees the job finish stores the clip to R2
  and charges it. A missing stamp is fal, and a missing endpoint stamp is the
  catalog id, so a job in flight from before finishes where it went.
- **Price:** `videoCostFromUsage` runs only on a direct via, on the endpoint
  stamped on the job. A gateway clip skips `price-motion-generation` and
  `deduct-credits`, and its version records no provider request id.
- **A cancelled clip is still charged, as before.** Cancel is data-only: the version is marked cancelled and the
  run goes on. The provider job is not stopped, so the gateway charges it
  when it finishes and the clip is discarded. A provider failure marks the
  job failed (`releaseGatewayRun`) and leaves the run's reservation to the
  run, which zeroes it at its end. A run that times out after 30 minutes
  ends its job itself (`releaseTimedOutVideoJob` → `releaseInProcessJob`, in
  a `release-motion-job<tag>` step) before it throws; a release that fails is
  logged, never thrown, so the run still reports the timeout; the stale-job sweep is
  only for a run that died (a borrowed reservation is not on the row, so the
  sweep cannot zero it). A capture
  renews the reservation's `RESERVATION_TTL_MS` (6 hours), and a 30-minute
  poll window sits well inside it.
- **The charge is recorded.** A studio asset's `costMicros` and the motion
  and studio span cost come from the run's own job row (`readGatewayCharge`,
  a `read-gateway-charge` step, by the id in the handle, through
  `scopedDb.claims`). A job that answered at submit names its job in the
  `done:` handle too (`doneVideoJob`); the transport's `done` answer carries
  the job id (null on the own-key Models-page transport, which holds no job)
  but no cost; #2438 may add one when it designs the HTTP transport.
- **Failures read as the provider's.** Seedance's failure handling
  (`isSeedanceInternalServiceError`, `explainSeedanceFailure`) asks
  `videoJobProviderVia(job)`, the provider behind a gateway job (from its
  handle), not the stamped `openstory`. The in-process poll passes the
  provider's own `code: message` through, so an Ark `InternalServiceError`
  still gets one new job (a `-internal` route step and submit key; the
  failed job's own hold was released by the poll), `QuotaSharedPoolExceeded`
  still reads as busy, and a stored URL is still stripped. On fal these
  helpers do nothing, gateway or not.
- **Packed clips:** one run, one submit, one gateway job, one charge.
- **Upload rights:** `video-job.ts` passes `UPLOAD_RIGHTS_CHECKED`. Studio
  checks every upload at the click (`requireCheckedUploadRights`); motion's
  stills and sheets passed the same gate when saved, and its reference clips
  are checked in `check-reference-clip-rights`.

### Holdable today (2026-11-26)

The product's real request bodies, priced against the live cards:

| Model (via)                         | Holdable | Why not                                               |
| ----------------------------------- | -------- | ----------------------------------------------------- |
| Grok Imagine Video 1.5 (native xAI) | Yes      |                                                       |
| Kling v4, i2v and reference (fal)   | Yes      |                                                       |
| Kling O3 reference (fal)            | Yes      |                                                       |
| Omni Flash i2v and reference (fal)  | Yes      | (native Google is the product's via; see below)       |
| Seedance 2.0 mini (fal)             | Yes      |                                                       |
| Seedance 2.5 reference (fal)        | Yes      |                                                       |
| Seedance 2.5 i2v (fal)              | No       | prices, but the schema check refuses `aspect_ratio`   |
| Seedance 2.0, 2.5, mini (Ark)       | No       | card lever `input_video` has no estimate              |
| Omni Flash (native Google)          | No       | usage-only card (tokens), no estimate                 |
| Kling v3 Pro i2v (fal)              | No       | card `generate_audio` is an enum; the field a boolean |
| MiniMax H3 Max (fal)                | No       | card `resolution` is lower case; the schema `768P`    |
| Grok Imagine Video 1.5 (fal)        | No       | card `image_url` is typed boolean                     |
| Seedance 2.0 enterprise (fal)       | No       | unknown model                                         |
| Sync lip-sync v3 (fal)              | No       | usage-only card (`minutes`), no estimate              |

With platform keys the product sends Grok to xAI, Seedance to Ark and Omni
Flash to Google, so today only Grok and the fal Kling and Seedance models
reach the gateway. The four upstream card issues (Kling v3 `generate_audio`,
MiniMax `resolution`, Grok-on-fal `image_url`, Grok video resolution lever)
are **not yet filed**; the ready texts are in the PR under "Upstream issues
to file".

### Real run (bun dev, 2026-11-26)

One shot through `generate_shot_video` → `MotionWorkflow`, Grok Imagine
Video 1.5, 2 s asked (6 s rendered), 720p, platform keys:

| Path      | Hold  | Charge | Lines | Output    |
| --------- | ----- | ------ | ----- | --------- |
| openstory | $0.48 | $0.48  | $0.48 | MP4 in R2 |

One gateway job, one hold settled to zero, one debit; no `deduct-credits`.
The run's own $0.05 reservation was zeroed at the batch's end.

**Needs sign-off:** the same request on the direct path was billed $0.84 by
xAI. The Grok video card prices `duration` only ($0.08/s, the 480p rate) and
has no resolution lever, so a 720p clip is charged about $0.36 under cost.

A first attempt went direct: the local snapshot was empty and the live
catalog read got a 429. Routes now read the stored snapshot only.

### Lip-sync

`LipsyncWorkflow` stays on the direct fal path: its card has no estimate.
It now builds a fal client per step (`lipsyncFalClient`). The shared
`fal.config` it used put an organization's key on the module client and then
awaited, so two runs in one isolate could send each other's key
(`lipsync-fal-client.test.ts`).

### Delete in #2439

Kept only for own keys and unholdable models: the direct submit branches in
`submitMotionJob` / `submitStudioVideoJob`, the non-`openstory` arms of
`pollVideoJob`, `videoCostFromUsage`, the motion and studio
`deduct-credits` / `price-motion-generation` / `price-video-generation`
steps, `recordFalUsageStep` for video, and `lipsyncFalClient`.

## Audio on the gateway (#2436)

### Coverage (read 2026-11-26)

Every ElevenLabs model on modelschemas answers `pricing: null`
(TanStack/schemas#756; #120 closed, but no card is served), so no ElevenLabs
call can be held today and every one runs on the direct path, platform key
only, unchanged. The `elevenlabs` provider and driver exist so Music moves
the day its card does.

- **In-process only.** The platform key reaches the whole shared account,
  where saved voices are account-wide slots the product owns
  (`voiceProviderOf`, `releaseVoiceIfUnreferenced`). Until the gateway owns
  voices per organization, the public endpoint refuses every ElevenLabs
  model, so no caller can name another organization's `voice_id`, and the
  driver calls only `ELEVENLABS_ENDPOINTS` (`v1/music`); any other endpoint
  is "not configured" and refused before the hold.
- **Driver** (`providers.ts`): platform key only (`OWN_KEY.elevenlabs` is
  null in `route.ts`); `configured()` is that list and
  `isElevenLabsConfigured()`; the
  key is resolved per call; a 429 (the account's concurrency cap, never
  run) is resent by `retryOnRateLimit`. An `audio/*` answer is one media
  file; any other answer fails the job.
- **No JSON result.** The issue's JSON result (voice ids, timestamps) is
  not built: every call that answers one (voice design, dialogue with
  timestamps) cannot be a gateway body today (below), so nothing would
  produce it.
- **A body is JSON only.** A query parameter has no place in it, and the
  driver never moves a field out of the body. Voice design needs
  `output_format=mp3_44100_128` (the 192 kbps default needs the Creator
  tier) and dialogue needs `output_format=wav_44100` (the ranges are cut
  from PCM WAV), so neither is routed even once a card exists. Scribe,
  isolation and speech-to-speech take a multipart file, which a gateway
  body cannot carry either. Both are limits of our gateway's design (a JSON
  body, sent as it is), not gaps in modelschemas.
- **Routes.** Seed takes and Music read the run's `gatewayRoutes`
  (`gatewayRunRoute`); the audio root triggers resolve
  `AUDIO_ROUTE_TARGETS` (`src/audio/gateway-targets.ts`) and children
  inherit them. A payload with no routes runs direct, so a run queued
  before the deploy finishes on its old path. Both callers go through
  `runAudioOnGateway` (`src/audio/server/audio-gateway.ts`), which passes
  the run's `reservationId` as the transport's `reservation`: a run that
  reserved at its trigger is charged against that and holds nothing more.

| Product call               | modelschemas                                                                                                            | Card                       | Where it runs                                |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------- |
| Music                      | `elevenlabs/music_v2_5`, `v1/music`                                                                                     | no, TanStack/schemas#756   | direct; the gateway once a card exists       |
| Voice design               | `elevenlabs/eleven_ttv_v3`, `v1/text-to-voice/design`                                                                   | no, TanStack/schemas#756   | direct: `output_format` is a query parameter |
| Save a designed voice      | no model, `v1/text-to-voice`                                                                                            | account state, not a model | direct                                       |
| Dialogue                   | `elevenlabs/eleven_v3`, `v1/text-to-dialogue/with-timestamps`; the row names only text-to-speech (TanStack/schemas#757) | no, TanStack/schemas#756   | direct: `output_format` is a query parameter |
| Mic take, ElevenLabs voice | `elevenlabs/eleven_multilingual_sts_v2`; the row names text-to-speech, not `v1/speech-to-speech` (TanStack/schemas#757) | no, TanStack/schemas#756   | direct: a multipart file                     |
| Scribe                     | `elevenlabs/scribe_v2`, `v1/speech-to-text`; no row (TanStack/schemas#757)                                              | no, TanStack/schemas#756   | direct: a multipart file                     |
| Isolation                  | no model, `v1/audio-isolation` (TanStack/schemas#757)                                                                   | no, TanStack/schemas#756   | direct: a multipart file                     |
| Seed Audio takes           | `byteplus/seed-audio-1.0`, `tts/create`                                                                                 | yes                        | gateway on a platform key                    |

`seed-asr` has a card with no estimate (TanStack/schemas#672) but the product
does not call it.

### Seed takes

A Seed take is recorded by a `SeedRecorder` (`seedRecorderFor` in
`seed-audio.ts`, which picks per take from the run's routes):
`gatewaySeedRecorder` holds and charges each take through the in-process
adapter, `platformSeedRecorder` calls Seed Speech on the platform key and the
caller books `seed-audio` itself (`seedCharge`). The body is the same.

- **One key per take.** `${runId}:${step}:${take}`, with no attempt: a
  step retried after Scribe, isolation, R2 or D1 throws gets its charged
  takes back and records nothing new. A take that fails the transcription
  check is retaken inside the step under the next take number (the range
  read up to three takes, dialogue and mic takes in their own loops).
- **Every take is charged.** On the platform key only the kept take is
  billed and the platform absorbs the rest; on the gateway every take that
  answered is charged. Needs sign-off.
- **The WAV is read back.** The gateway stores the take in R2 in the step
  that recorded it; the caller reads it back to transcribe and cut it, so no
  bytes cross a `step.do`.
- **Cloning.** `references[]` with `audio_url` or `audio_data` is refused on
  the public endpoint (the likeness check cannot hear whose voice a clip
  is) and held for an in-process caller. `seed-audio.ts` is on the
  `UPLOAD_RIGHTS_CHECKED` allowlist (through `audio-gateway.ts`): its clips are the organization's Seed
  voice clips, made from text, and a mic take is the user's own recording
  made in the app. The job row keeps inline media (`audio_data`,
  `inlineData` and the other inline keys) as `{ sha256, length }`, never
  the bytes, and so is any `data:` URL over 256 characters in any field, so
  a 30 second clip stays under D1's 2 MB row; a replayed key
  is compared on the digest, and the provider still gets the whole body.
- Pacing stays on the BytePlus governor: the Seed Audio driver calls
  `acquireSeedSpeechToken` before every call.
- Scribe and isolation stay ElevenLabs ledger lines (`deductWorkflowCredits`).

Real run on `bun dev` (2026-11-26): Generate voice, one Seed take, routed
`openstory`. The first attempt's Seed call answered 500 (`audio risk audit`),
so the step retried under attempt 2 and a new key; that take was held $0.30
and charged $0.11975 once (47.9 s), one debit and one line. The run booked
Scribe ($0.0029) and isolation ($0.0718) and no `seed-audio` line. That run
found two hold bugs, both fixed since: the charged take kept $0.18025 of its
hold until the hold expired (a settled job now zeroes its own hold in the
settle step), and the 500 left its job `running` with its hold. Now a
start's error is read by whether the driver answers at once
(`answersAtOnce`: Seed, Ark images, Grok images, Gemini, ElevenLabs) or
queues a job (Ark tasks, Grok video, fal). The rule, for both the public
run and the in-process transport (`claimAndStartGatewayRun` in
`phases.ts`):

- A 4xx fails and releases.
- A 429 from any start, or the origin's own 500 or 503 from a start that
  answers at once, ran nothing: the job goes back to `queued` with its hold
  and the retried step sends it again under the same key.
- Anything else fails and releases, and is never sent twice: any 5xx from a
  queued start, a proxy's 502, 504 or 52x (Cloudflare in front of xAI or the
  Seed edge, which can follow a request that finished and was billed), a
  timeout or a dropped connection. A 500 or 503 from a queued start fails at
  once; the rest fail when the retried step finds the job `running` with no
  provider id. fal's SDK errors carry `status`, not `statusCode`, so a fal
  submit error takes that last path.

## Text (#2437)

Every LLM call the product makes on a platform key is charged in one place:
a meter on the key, read by the adapter wrapper. On a text card the price is
the gateway's (the card plus the platform fee); with no card it is today's
`llmCostFromUsage`. An organization's own key (OpenRouter, fal, xAI, Google,
LLMTR) carries no meter and is never charged. No call site bills an LLM call
any more.

### The route

Decided once per call, where the key is decided: `resolveLlmKey`, wrapped by
`withTextGateway` (`src/gateway/server/text.ts`) in `createScopedDb`. Every
platform key comes back with a `meter`. Its `card` is set when the model has
a text card in the snapshot that prices `input_tokens` and `output_tokens`;
otherwise it is null and the call is priced as today. `resolveNativeGrokModel`
and `resolveNativeGeminiModel` still pick the provider, so the card is the
provider's own: `openrouter/<id>`, `grok/<xAI id>` or `gemini/<Gemini id>`.
The card is read from the snapshot in the step that spends it, like the key:
it is a platform price, not a row the user writes. This is the text form of
the routing rule. `resolveGatewayRoute` is for media, whose own-key rule is
per provider, while text follows `resolveLlmKey`'s order. The card follows
the key that resolved, so a card for a provider whose platform key this
server does not have is never used: with no Google key a Gemini model
resolves on OpenRouter and is priced on OpenRouter's card or direct.

A call goes direct (priced as today) with a reason recorded on its
transaction:

| Call                                                                                                 | Reason                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A model whose snapshot row is missing or whose card cannot price tokens                              | `no card`                                                                 |
| OpenRouter through the platform fal key (no `OPENROUTER_KEY`)                                        | `no card` (fal's OpenRouter proxy has none)                               |
| Every llm-client OpenRouter call (`callLLM`, `callLLMStream`), which sends `serviceTier: 'priority'` | `service tier priority is not on the card` (upstream issue not yet filed) |

Every OpenRouter call through llm-client's `buildModelOptions` sends
`serviceTier: 'priority'`: script enhancement, the scene split, element and
talent vision, the studio prompt draft, `ai.fn`, describe-upload and
watch-clip. No card has a tier lever, so these are priced as OpenRouter
billed them until one does. The durable helpers (`chatModelOptionsForCall`),
the assistant, the public endpoint and native xAI and Google calls send no
tier and are priced on the card.

Every LLM key carries its charging mode in the type (`LlmKeyInfo.meter`,
required), and the key is a union on `source`: an organization's key
carries only `{ uncharged: 'own key' }`; a platform key carries a
`TextMeter` or `{ uncharged: 'no organization' }` (nobody to charge). So a
platform key cannot be marked `own key` and run free: it does not
type-check. `createAdapter` and llm-client take the key as a
required argument, so no call builds an adapter on an implicit platform key.
Only `getPlatformLlmKey` mints a `no organization` key, and
`unmetered-llm-keys.test.ts` pins the files that may call it: the
definition; the unwrapped `apiKeys` (which only `scoped.ts` builds, inside
`withTextGateway`); `text.ts`, which meters it; and llm-client's Google
re-run of a call already marked uncharged. A durable call takes the run's
`scopedDb` as a required argument, and `WorkflowScopedDb.apiKeys` has no
LLM resolver, so a run reaches its key only through
`credentials.resolveLlmKey`, metered for the run. The same test also fails on any other file that
writes `OWN_KEY`, a reason literal, a bare `uncharged:` or copies a meter
from another key (`meter: someKey.meter`).

**Unfunded script enhancement (#1567).** Its meter is `whenShort: 'run
free'`, so the call's own hold decides: a request the balance cannot hold
(on the card route) runs free, and on the direct route it is charged only
what `tryDeductCredits` can take. Never refused, never a negative balance,
and there is no separate pre-check whose amount could disagree with the
hold. This is the only `allowUnfunded` caller. The other `prepareBilling` callers (`ai.fn`:
prompt shortening, scene duration estimate, style recommendation) refuse
with `InsufficientCreditsError` as before.

**Google region re-run with no resolver** (the `ai.fn` sites pass none).
A metered key re-runs through its meter's resolver, so the re-run is
charged on its own route. A key marked `no organization` re-runs
uncharged on the platform's key, as it was. An
organization's own Google key is refused (the error surfaces): it never
re-runs on a platform key, as before #2437.

The gateway submit's likeness check (`withPlatformLlmKey`) spends the
platform's key, never the organization's, and is metered like any other
request. Before #2437 it was billed to the organization (`billTalentVision`,
`likeness:<url>`). It still is, once per checked URL, pinned by
`platform-credentials.test.ts`.

The snapshot holds a text card for every `SCRIPT_ANALYSIS_MODELS` id on
OpenRouter, plus the native Grok and Gemini ids (`productTextModels`). A
text row stores the card only: the body is the route adapter's and is never
validated against a schema, so the refresh asks modelschemas once per text
model, inside the same time budget and per-model failure isolation as media.

### The adapter

`createAdapter` builds the route's adapter as before. When the key carries a
meter, it returns `openstoryText(adapter, meter, model)`: a proxy whose
`chatStream`, `structuredOutput` and `structuredOutputStream` each delegate
and then charge once. It fails closed: any other adapter method that could
call the provider (`compact`, or one added upstream later) throws rather
than run free; only `supportsCombinedToolsAndSchema` and
`combinedStructuredOutputSource`, which call nothing, pass through. Nothing it sends changes, so `chat()` keeps tools,
structured output, web search, vision input, reasoning and durable streams,
and the four provider protocols are not re-implemented. Each provider request
is one charged call: an agent-loop turn, or a separate structured-output
call. A key resolved for one model is refused for another (the #1358
mismatch), so a call is never priced on another card. The Google region
re-run and llm-client's model fallback re-resolve through the meter's
resolver, so the retry is metered on its own route.

### Money

- **Inside a workflow run there is no per-call hold.** `base-workflow`
  resolves keys through `forWorkflowRun` (`scoped-workflow.ts`), which
  carries the payload's `reservationId`. On the card route each call settles
  its lines against the run's reservation (`settleReservation`, which
  captures without closing). On the direct route it captures the cost
  (`captureReservation`). A run with no reservation takes a hold at charge
  time and closes it in the same call (card), or uses `tryDeductCredits`
  (direct). A short balance is reported as a skipped deduction, never thrown
  into the run. There is never a second hold.
- **A request with no run** (a server fn, the assistant, the public
  endpoint) holds before the first byte, only on the card route. The hold
  is the card priced on `input_tokens` and `output_tokens`. `input_tokens`
  is the UTF-8 bytes of the system prompts, messages, tool names and
  descriptions and the output schema (a token is at least a byte), with each
  image, audio, video or document part counted at 4,096. `output_tokens` is
  the request's own output budget (`maxTokens`, `max_tokens`,
  `max_output_tokens` or `maxOutputTokens`). A request that sets none is
  refused before the hold. A direct-route request is deducted at the end,
  as today.
- **Charge at the end:** the card is priced on the usage the stream reported,
  mapped to OpenAI Chat usage and through `normalizeUsage`, so cached,
  cache-write and reasoning tokens are priced on their own levers. OpenRouter's
  server-side web searches (`serverToolUseDetails.webSearchRequests`) are
  priced on the card's `web_searches` lever. The card route never uses
  `llmCostFromUsage` or the provider's `cost`.
- **A charge above the hold** grows the hold while the balance allows (the
  capture in `settleReservation` / `captureReservation`). Otherwise the
  shortfall is reported as a skipped deduction (`reportSkippedDeduction`) and
  the call is not charged for it.
- **Cut off** (the caller disconnects or aborts, at any point, or the
  provider fails after content): with no usage reported, the prompt and what streamed are
  estimated at UTF-8 bytes / 3, rounded up, capped at what the request's
  output bound would have held (the hold itself for a request; computed at
  charge time in a run). Bytes / 3 is about 1.3x for English and about right
  for CJK: an under-estimate is paid by the platform and can be had by
  aborting every stream, so the estimate errs slightly high. A caller that
  disconnects before the first text still pays the prompt estimate, since
  the provider bills the prompt and any hidden reasoning. Only a provider
  failure before any text (a refusal, a Google location refusal, a 4xx,
  a run error) is free, and its own hold is released. The direct route
  applies the same rule, pricing the estimate with `llmCostFromUsage`
  (native Grok, Gemini and LLMTR rates); it has no rate for an
  OpenRouter model without the provider's `cost`, so such a call stays
  uncharged (reported as a missing cost) until it has a card.
- **What a charge records:** each charge line's `sku` is
  `<provider>/<model id>`, so the #2439 usage view groups lines by model and
  day. The transaction metadata holds the via, the model, the card, the
  direct reason and the usage. A public-endpoint call carries its OAuth
  client (`attribution.oauthClientId`).
- **Idempotency:** each call is charged under `text:<id>`. A single-call
  site that may repeat for the same input passes its own key through
  `forCall`: the likeness check uses `likeness:<url>` and the element
  draft uses `draft-vision:<url>`.
- **Description:** every metered call names its purpose (`forCall`'s
  `describe`, required: an unnamed metered call is refused before the
  provider call). The wording is the one each site wrote before #2437:
  `Script enhancement`, `Prompt shortening (m)`, `Scene duration estimate
  (m)`, `Style recommendation (m)`, `Upload description (m)`, `Talent vision
  (m)`, `Element vision (m)`, `Studio prompt draft (m)`, `Assistant (m)`,
  `Watched a clip (m)`, and `LLM analysis (m)` for every durable helper in a
  run. The public endpoint writes `Gateway chat (m)`.

Output bounds set at call sites that had none (all requests with no run):
element vision 2,048; talent vision 4,096; studio prompt draft 2,048;
`recommendStyles` 2,048; describe-upload 2,048; watch-clip 4,096; script
enhancement `min(32,000, model max)` (4,000 truncated, #915); assistant
8,192 per model call. `shortenPrompt` (500) and `estimateSceneDuration`
(2,048) already had bounds.

**Behaviour changes.** An LLM call is charged when it happens, not in a
deduct step after it, so a run that fails later still pays for the calls it
made. A retried step that calls the provider again is charged again. A run
in flight at deploy whose LLM step is cached but
whose old deduct step has not run is not charged for that call.

### D1 per call

From the measured parts (the billing module's own logger on the test D1):
a hold is 3 round trips (a replay read, the `credits` upsert, the
reservation insert). A settle is 4: a replay read, a reservation read, one
atomic batch (the capture, the transaction, the balance and the charge
lines), and a read of the lines. A release is 1. Add the snapshot read in
`resolveLlmKey`:

- **In a run, on a card:** 5 round trips, one write batch.
- **A request on a card:** 9 round trips, about 8 written statements.
- **Direct route:** 1 to 3, as today.

A sequence's analysis runs in a workflow, so it pays the first figure.

### The public endpoint

`POST /api/v1/gateway/chat/{model}` (`src/gateway/server/chat.ts`) runs one
text model on the same meter and streams AG-UI events. `{model}` is an
OpenStory analysis model id. The body is text turns, an optional system
prompt and a required `maxTokens`. Tools and media are not accepted: inline
media and tool execution stay on the trusted in-process path. It spends
platform keys only (`resolvePlatformLlmKey`), so a model whose card cannot
price it is refused, never run direct. `/gateway/*` already needs
`models:invoke` on an OAuth token, and the client id is recorded on the
charge.

### Real runs (2026-11-26, local, platform keys)

The snapshot was seeded with the Sonnet 5.5 OpenRouter card only, so each
run also shows the route per call. Every charge equalled OpenRouter's own
`usage.cost` for the call, and each call was charged once.

- **A funded run** (`stopAt: references`, an 840,000-micro run
  reservation): two LLM calls drew on the run's reservation with no hold of
  their own: the Sonnet analysis call on the card, and the Opus 5.5 split
  direct with `no card`. Two llm-client calls went direct with the priority
  tier reason.
- **An unfunded run** (`stopAt: script`, no reservation): the card call took
  a hold of exactly its charge at charge time and closed it. The
  enhancement request was deducted direct with the priority tier reason.
- **One assistant turn with a tool call** (`openstory_list_sequences`): two
  Sonnet calls, each holding about $0.14 on the 8,192 bound, charged $0.0447
  and $0.0058. No separate assistant deduction.
- **The public endpoint** (`maxTokens: 32`): held 494 micros, charged 116.
- Every request hold was released, and every card line carries `sku`
  `openrouter/anthropic/claude-sonnet-5.5`.

### No job row

A text call writes no `gateway_jobs` row. It has nothing to poll, store or
read back, and a row would add a write to every call. Its record is the
`credit_usage` transaction and the charge lines (`sku` set,
`gateway_job_id` null).

## Self-hosted on one key (#2438)

A self-hosted install with `OPENSTORY_API_KEY` set sends each provider it has
no key for to the hosted gateway (`OPENSTORY_GATEWAY_URL`, default
`https://openstory.so`) over the public job API. The key's organization pays
there.

### Decisions

- **One more route, decided once at the trigger.** `resolveGatewayRoute`:
  an organization key -> direct; a key for the provider on this server ->
  today's paths (`openstory` in-process when holdable, else direct); no key
  here and `OPENSTORY_API_KEY` set -> `remote`; else direct. A key on this
  server is read per provider even with no snapshot row (`serverHasKey`), so
  a provider key in the install's own environment always wins. The payload
  carries `{ via: 'remote' }`; `gatewayRunRoute` returns it with no body
  check. The hosted side checks the schema and the card, so the install needs
  no snapshot and no card to route.
- **Never a fallback.** A hosted refusal (`400`, `402 INSUFFICIENT_CREDITS`,
  `404 Unknown model`, a card that cannot price the request, a real person in
  an input) is a `NonRetryableError` reading `CODE: message` as the hosted
  side wrote it. A `429` or `5xx` is left to the step's retry; the same
  Idempotency-Key makes the resend safe. Nothing is tried on a local key.
- **No local hold, no local debit.** The HTTP transport never touches the
  install's database: no `holdGatewayJob`, no settle, no
  `deductWorkflowCredits` (the call sites skip it on the `openstory` via, which
  a remote result carries). The run's preflight (`requireCredits`,
  `reserveRunCredits`) skips the local check and hold only when no call of
  the run can spend on this server: an OpenStory key and no platform key at
  all (`onlyHostedGatewaySpends`), so every paid call is remote or refused
  before it spends. One platform key (fal, OpenRouter, xAI, Google, Ark,
  ElevenLabs, Seed) and every run checks and holds as before, its whole
  estimate, remote calls included; that over-holds and is released at the
  run's end. Splitting the hold per call needs per-call estimates, which the
  triggers do not have. Platform-only work (`providers: []`) always holds.
  `preflight.test.ts` (all remote, mixed, all local) and
  `adapter/http.test.ts` pin it (the transport runs with a `scopedDb` that
  throws on any touch). The hosted charge is shown, never debited: a clip's
  `costMicros` comes from the hosted job document (`remoteJobCharge`), and
  every finished job logs its id and charge.
- **The handle is opaque.** A queued remote job's handle is `remote:<hosted job
  id>` (`remoteHandle`, `src/gateway/server/remote-config.ts`), never the run
  as JSON. `gatewayPoller(handle)` polls it over HTTP; `gatewayRunOf` answers
  null for it; a timed-out remote clip is not released (the hosted job ends
  and is charged there).
- **The key is a secret.** Read from env inside the call that spends it
  (`remoteGateway`), sent only as `Authorization: Bearer`, never on a
  payload, in a URL or a log.

### The transport

`src/gateway/server/adapter/http.ts`: `gatewayTransport(route, …)` is the one
place a call site turns a route into a transport (in-process or HTTP), and
`gatewayPoller(handle, …)` the one place a poll does. Stills
(`image-generation.ts`), audio (`audio-gateway.ts`) and video
(`video-job.ts`) use them.

- **Bodies need no key here.** A still's Grok body is built with none; a
  sequence or studio clip on the fal via skips `resolveFalKey` and the
  fal-storage upload when its route is remote (`routesRemote`), so the body
  keeps its local `/r2/` URLs for the transport to upload.
- **The Models page** decides at the click (`hostedRouteFor`): no key here
  for the provider and an OpenStory key -> `route: { via: 'remote' }` on the
  payload, with no local job, hold or check beyond the account gate. The run
  sends the body as it is over HTTP under `asset:<assetId>` and records the
  asset as `openstory`. The activity is the client's word on this route (no
  local model row); the hosted side runs the model it names.
- **Only the run's own files leave.** A local `/r2/` key whose owner segment
  is not the run's organization is refused before storage is read
  (`isCheckable`), for every caller. The Models page click also runs the
  rights check and, for fal, the input schema, as the direct path does.
- **No path can be retargeted.** A model id must match `HOSTED_MODEL_ID`
  (`src/gateway/schema.ts`; the Models page input schema uses it too) and
  each segment is encoded (`hostedModelPath`); a job id must be a ULID, both
  when the hosted side answers it and when a handle is polled.
- **Submit:** every local `/r2/` string in the body is uploaded first, then
  `POST /api/v1/gateway/{provider}/{model}` with the call's Idempotency-Key.
- **Poll:** `GET /api/v1/gateway/jobs/{id}?wait=20s`.
- **Results:** each output URL is copied into the install's storage through
  the caller's `store`, as a provider CDN URL is. A retried poll copies again
  (one orphaned object at most); the charge is the hosted job's, once.

### Text

An install with no LLM key (no organization key, no `OPENROUTER_KEY`,
`FAL_KEY`, or native key for the model) and an OpenStory key resolves
`via: 'openstory'` in `resolveLlmKey` (`getHostedLlmKey`), the same seam every
LLM call already goes through, so the route is decided where the key is.
`createAdapter` answers it with `hostedTextAdapter`
(`src/gateway/server/adapter/http-text.ts`), which streams `POST
/api/v1/gateway/chat/{model}` and yields the hosted `chat()` events as they
arrive.

- **Charged there, never here.** The key's meter is `uncharged: 'hosted
  gateway'`; `withTextGateway` puts no meter on a `via: 'openstory'` key, so
  no local hold or debit can run (`text.test.ts` pins it). The hosted side
  holds and charges the key's organization; its refusal (`402`, `400`, ...)
  is the error the caller sees.
- **Plain text only.** A call with tools, a tool turn, an image or file part,
  or structured output is refused before anything is sent, naming what to
  set. Most pipeline calls use structured output, so a sequence still needs
  an LLM key on the install until the hosted endpoint takes them.
- **The budget is required.** The call's own `max_tokens` (any spelling
  `requestMaxTokens` reads) becomes the body's `maxTokens`.

### Uploads

`POST /api/v1/gateway/uploads` (`src/gateway/server/uploads.ts`): the body
is the file, `Content-Type` an image, video or audio type, `Content-Length`
required (at most 500 MB), `Idempotency-Key` required.

- **A fresh id, written once.** Each file is stored at
  `gateway-uploads/<organization>/<ULID>.<ext>` with a create-only write
  (`uploadFile(…, { upsert: false })`, R2 `if-none-match: *`), so no later
  write can replace the bytes the likeness check classified.
- **Checked before it is answered.** `requireCheckedUploadRights` runs on
  that exact URL; a refusal (a real person is `400 ATTESTATION_REQUIRED`)
  deletes the file and answers nothing. A pass answers `201 { url }`, and a
  submit finds the verdict. The check is charged to the caller as on a submit.
- **The key maps to the id.** After a pass, a create-only pointer at
  `gateway-uploads/<organization>/keys/<sha256 of the key>` records the file.
  A replay answers that file's URL and never stores again; a concurrent
  upload that loses the pointer race deletes its own file and answers the
  winner's. The install sends `sha256(<call key>:<r2 key>)`.
- **Only the owner's.** A submit naming a `gateway-uploads/<organization>/`
  URL of another organization is `400` before the check
  (`gatewayUploadOwner` in `submit-job.ts`).

`uploads.test.ts` and `submit-job.test.ts` pin each.

**Files expire only with a lifecycle rule.** Without it uploads are kept
forever. R2 lifecycle is not in `wrangler.jsonc`, so it is set once per bucket
by hand: `wrangler r2 bucket lifecycle add <bucket> gateway-uploads-1d gateway-uploads/ --expire-days 1`.
`bun setup --prod` prints this command. Needs sign-off: a manual step on the
production bucket.

### Rate limit

`GATEWAY_RATE_LIMITER` is 300 a minute per organization (was 60), in all
three wrangler blocks. Counted from the code paths, not a measured run: a
6-scene short with 3 shots a scene and 3 characters and 3 locations is 6
sheets, 18 stills and 18 clips (42 media submits) plus, once text runs
remote, about 41 chat calls (script analysis, a visual and a motion prompt per
shot). Stills and their prompts fan out at once, so that short peaks near 40
calls in a minute; a 30-scene sequence (`MAX_SCENES`) near 180. 300 leaves
room for content retries. Uploads are not counted; the per-key limiter (10 a
second) still applies.

### Not remote yet

| Call                                                          | Why                                                                                        | Where it runs                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| Every ElevenLabs call                                         | saved voices are account-wide slots; the public endpoint refuses ElevenLabs (`NOT_REMOTE`) | direct; needs `ELEVENLABS_API_KEY`    |
| Scribe, isolation, mic take                                   | multipart bodies; ElevenLabs                                                               | direct                                |
| Seed takes cloned from a voice clip                           | the public endpoint refuses `references[]` audio (the likeness check cannot hear it)       | hosted refusal                        |
| Real people in any input                                      | no portrait attestation on the public endpoint; BytePlus portrait slots are per account    | hosted refusal `ATTESTATION_REQUIRED` |
| Gemini images                                                 | TanStack/schemas#755                                                                       | direct; needs a Google key            |
| fal Flux, Seedream, Nano Banana stills                        | no gateway body built for them (only Grok stills route, § Product stills)                  | direct; needs a fal key               |
| A model the hosted card cannot price                          | the hosted side refuses                                                                    | hosted refusal                        |
| LLM calls with tools                                          | the hosted chat endpoint takes no tools                                                    | refused at the call                   |
| Structured output (script analysis, shot specs, most prompts) | the hosted chat endpoint answers text only                                                 | refused at the call                   |
| Vision (an image or file in a turn)                           | the hosted chat endpoint takes string content only                                         | refused at the call                   |

### Proof (2026-11-26)

The hosted side was `bun dev` on port 3008 with platform keys and an `osk_`
key on a test organization funded with $2. The install side was the HTTP
transport run from a test harness with no provider keys and a `scopedDb`
that throws on any touch, so no local hold or debit was possible.

| Model                                                 | Hosted jobs | Hold         | Debit          | Lines          | Copied here           |
| ----------------------------------------------------- | ----------- | ------------ | -------------- | -------------- | --------------------- |
| `grok-imagine-image`                                  | 1           | $0.02        | $0.02          | $0.02          | JPEG, 408,922 bytes   |
| `seed-audio-1.0`                                      | 1           | $0.30        | $0.004906      | $0.004906      | WAV, 188,428 bytes    |
| `anthropic/claude-sonnet-5.5` (text, 16-token budget) | 2 calls     | not recorded | $0.000076 each | $0.000076 each | streamed text "ready" |

The Grok call ran twice under one key: one hosted job, one debit. The text
call ran from a harness with an empty in-memory D1 and no LLM key:
`resolveLlmKey` answered `via: 'openstory'` with no meter, and the hosted
side wrote one charge line per call. Uploads:
the same key answered the same URL twice; a still with a person in it was
refused `ATTESTATION_REQUIRED`; a `text/plain` body was refused. Not proven
here: a full sequence on a fresh clone against a preview deployment, and a
workflow on a second install end to end (both need a deployment of this
branch).

## Not in this stack

- Moving the main app's own workflows onto the gateway. Roughly twenty
  workflows call the provider modules directly today; they move one domain at
  a time once the contract is stable.
- LLM calls, result webhooks, streaming.
- Extraction to a separate Worker.
- Cash payouts. They need Stripe Connect and legal review first.
- Reconciling the rate cards against provider bills. The charge is the card;
  a wrong card is our loss or the caller's until that exists.
