# Model gateway

Status: PR 1 (gateway core and app-pays) shipped; PRs 2–4 are the plan. This
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
  one D1 batch.
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
  charged. PR 2 replaces its body with the debit and its lines.
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
(`image`, `video`, `audio`), a request schema and a rate card.

Not served, and why:

- **A model whose card needs a number the request does not carry and gives
  no estimate for it.** Flux dev is priced per megapixel of the result,
  Gemini images per token, Seedream per input and generated image. There is
  no honest hold for those, so they are refused at submit until their cards
  carry an estimate.
- **Most BytePlus models are found by a fallback.** Their records name no
  activity and no endpoint (TanStack/schemas#649), so `catalog.ts` reads the
  kind off the output modality and maps it to Ark's two endpoints. A record
  with an empty output modality is not runnable.
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
3. **Settle:** one step prices the card with the usage, captures against the
   hold and writes `succeeded` with the outputs and the charge. Provenance
   (`gateway_job`) follows; a failure there leaves the job succeeded.
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
- The hold is the card's price for the request. The charge is the card's
  price for the request plus the usage the provider reported (BytePlus
  `completion_tokens`, Gemini `usageMetadata`); a card that reads no usage
  charges exactly the hold.
- The settle is `deductWorkflowCredits` with the job's `reservationId`
  (capture), idempotency key `${instanceId}:gateway-settle`. When the card
  refuses the reported usage the hold (`holdMicros`) is charged and reported
  as a missing cost, never settled free. `costMicros` is written with
  `succeeded`, in the settle step; the response shows it as
  `charge.totalMicros`.
- Insufficient credits at submit is `402 INSUFFICIENT_CREDITS` in the
  `/api/v1` error envelope, and leaves no row, so the same key can be sent
  again after a top-up.

### Idempotency

The `Idempotency-Key` header (≤ 255 characters) is unique per organization
on `gateway_jobs`. The key binds the job; the job binds the rest: the
reservation key is `gateway:<jobId>` and the trigger's `deduplicationId` is
`gateway-<jobId>`. A replay returns the first job whatever the path or body
says, and still counts against the rate limit. A key whose first submit was
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

- No reconcile sweep for a job left `running` when both the run and its
  `onFailure` die; the hold expires on its own TTL.
- No estimate endpoint; the hold is not shown before submit.
- The provider's own result object is not returned, only the stored media.
- `MODELSCHEMAS_API_KEY` must be set in production: the anonymous limit is
  60 requests an hour.
- An image the check finds a real person in is refused
  (`400 ATTESTATION_REQUIRED`): the gateway has no portrait-attestation field
  yet. A raw URL is classified on first use, an organization's own upload by
  its existing verdict, and another organization's file is refused.

## Not in this stack

- Moving the main app's own workflows onto the gateway. Roughly twenty
  workflows call the provider modules directly today; they move one domain at
  a time once the contract is stable.
- LLM calls, result webhooks, streaming.
- Extraction to a separate Worker.
- Cash payouts. They need Stripe Connect and legal review first.
- Reconciling the rate cards against provider bills. The charge is the card;
  a wrong card is our loss or the caller's until that exists.
