# Model gateway

Status: the stack is shipped: PR 1 (gateway core and app-pays), PR 2
(charge lines), PR 3 (apps and user-pays) and PR 4 (margin, app charges and
earnings). This file is the contract; § Shipped describes the code as it is.

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
| `GET /api/v1/gateway/grant`          | The caller's cap, spend and remaining       |
| `POST /api/v1/gateway/jobs/estimate` | Price before submitting, as lines           |
| `POST /api/v1/gateway/charges`       | An app charges one of its SKUs              |

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
  registered, active app. An app charging its own organization earns nothing:
  no margin, and `POST /gateway/charges` refuses it.
- Margin is capped at `MAX_APP_MARGIN_BPS` (5000). The margin a job applies
  is the lower of the app's current margin and the one the user accepted on
  the grant (§ Shipped (PR 4) § Consent).
- An `app_charge` names a SKU the app declared in advance, at most
  `MAX_APP_SKU_PRICE_MICROS` ($100); an app cannot charge an arbitrary amount,
  nor a price above the one the user accepted.
- The cap on a grant counts every line: settled lines this calendar month
  (UTC) plus live holds for that client and organization (§ Shipped (PR 3)).

## Earnings

A payee line creates an earning row in state `pending`, in the line's own
batch and at the line's written amount. After `EARNING_HOLD_DAYS` (14) the
hourly sweep matures it: the app's organization wallet is credited with a
`credit_earned` transaction and a `creditBatches` row with source `earned`,
exactly once. A charge reversed inside the hold cancels the earning instead
(`earnings.cancelPending`; no refund flow calls it yet). Earnings are credits
only: not transferable, not redeemable, and there is no payout code.

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
   consented margin and SKU prices on the grant, the `app_margin` line,
   declared SKUs and `POST /gateway/charges`, `gateway_earnings` with the
   hold and the maturing sweep, the estimate endpoint, the price on the
   consent screen, and job reads scoped to the OAuth client.

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
and caller on `gateway_jobs` (PR 4: each OAuth client has its own key space,
and `osk_` keys and sessions share the organization's). The key binds the job; the job binds the rest: the
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

## Shipped (PR 3)

### Code

- `src/platform/server/db/schema/gateway-apps.ts`: tables `gateway_apps`
  and `gateway_grants`; migration `20261111224833_gateway_apps_and_grants`
  (two new tables and two `ADD COLUMN`s on `credit_reservations`; nothing is
  rebuilt). No foreign key into the Better Auth tables; the organization
  keys are `restrict`.
- `src/platform/auth/oauth-spend-cap.ts`: the cap bounds
  (`DEFAULT_MONTHLY_CAP_USD` 20, `MIN_` 1, `MAX_` 1000, whole dollars) and
  `monthlyCapMicrosSchema`. Client-safe; it lives in platform because the
  consent screen is platform's and platform may not import a domain.
- `src/billing/server/db/spend-cap.ts`: the one SQL definition of a grant's
  spend (`monthSpendSql`), holds (`liveHoldsSql`) and the guard
  (`fitsUnderCapSql`).
- `src/billing/server/db/billing.ts`: `createReservation(…, { spendCap })`.
- `src/gateway/server/db/gateway-grants.ts`: `scopedDb.gatewayGrants`,
  bound to the signed-in user: `getStanding`, `listStandings`, `setCap`
  (upsert, guarded by membership in the same insert), `revoke`.
- `src/gateway/server/db/gateway-apps.ts`: `scopedDb.gatewayApps`: `list`,
  `register` (guarded insert), `getByOAuthClient`.
- `src/gateway/server/submit-job.ts`: the app and grant checks, the capped
  hold and its refusal codes. `src/gateway/server/errors.ts`: the codes.
- `src/gateway/server/read-grant.ts` and `src/routes/api/v1/gateway.grant.ts`.
- `src/gateway/server/register-app.ts`, `src/gateway/apps.fn.ts`,
  `src/gateway/ui/gateway-apps-settings.tsx`: Settings → Developer → Apps.
- `src/platform/server/auth/oauth-consent.ts`: the consent decision writes
  the grant, revoke revokes it, `setAuthorizedAppCap`; the consent page and
  Settings → Authorized apps show and change the cap.

### Grants

One row per (OAuth client, user, payer organization), unique on the triple:
`monthly_cap_micros`, `revoked_at`. The JWT is stateless and lives up to an
hour, so the grant is looked up on every submit, not carried in the token.

- **Consent.** When the signed query's `scope` holds `models:invoke`, the
  consent page shows a monthly cap between the organization select and the
  credits copy, prefilled with the client's current cap for the picked
  organization, else the default. `decideOAuthConsent` refuses an approval
  without a valid cap before the provider sees it, and writes the grant for
  the picked organization once the provider answers with a redirect that
  carries no `error`. Re-consenting updates the cap and revives a revoked
  grant. A denial writes nothing.
- **Revoke.** `performAuthorizedAppRevoke` revokes the grant for the
  consent's organization first (every organization's when the consent row
  is already gone, matching the tokens), then the tokens, then the consent.
  A still-valid access token then gets `403 GRANT_REQUIRED` on submit. Jobs
  already running finish and settle.
- **Settings → Authorized apps.** A consent with `models:invoke` shows its
  cap, settled spend this month and remaining, and a cap editor
  (optimistic, rolled back on error). A consent that has `models:invoke` but
  no grant (one approved before PR 3) shows "no spend cap yet" and can set
  one there; until then the gateway refuses it. An authorize request that
  names no `scope` is not such a case: the provider writes the client's
  registered scopes (else its own defaults) into the signed query before the
  redirect (`authorize` in `@better-auth/oauth-provider`), so the consent
  page sees `models:invoke` and asks for a cap like any other.

### The cap

`createReservation` with `spendCap: { oauthClientId, appId }` inserts the
hold only if, in the same `INSERT … SELECT`, the balance guard holds and a
live grant of (client, this user, this organization) exists with

```
monthly_cap ≥ settled lines this UTC month (payer, client)
            + live holds (payer, client) + this hold
```

Settled lines are `charge_lines` by `organization_id`, `oauth_client_id`
and `created_at ≥` the month's first second. Live holds are
`credit_reservations` with that `oauth_client_id`, `remaining_amount > 0`
and `expires_at > now`; the hold carries `oauth_client_id` and `app_id`
(new nullable columns). D1 runs one statement at a time, so two submits
that together pass the cap cannot both hold. A refusal is classified after
the fact by reading the grant again: no live grant → `403 GRANT_REQUIRED`;
hold above remaining → `402 SPEND_CAP_EXCEEDED` with `monthlyCapMicros`,
`spentMicros`, `heldMicros`, `remainingMicros` and `requestedMicros` in
`details`; else `402 INSUFFICIENT_CREDITS`. Spend is per (payer, client),
not per user: two members of one organization who both connect the same app
share its spend, each against their own cap.

**Growth.** A settle above its hold is not blocked by the cap: the capture
grows the hold when the balance covers it, as before, and the lines it
writes count against the cap from then on, so the next submit sees them.
`remainingMicros` is never negative. `capture` and `settleReservation` are
unchanged, so short capture and lines-sum-to-debit hold exactly as in PR 2.
A caller without `spendCap` (every existing caller and every `osk_` submit)
runs the same statement it did before, with the two new columns null.

### Apps

`gateway_apps`: one row per OAuth client (unique), owned by an organization:
`name`, `status` (`active` | `suspended`), `created_by_user_id`. Registering
is an owner's or admin's act and links a client only when the signed-in user
created it: the insert selects from `oauth_client` where `client_id` and
`user_id` match, so another user's client, an unowned DCR client and an
unknown id all write nothing. With no client id, Settings first creates a
public PKCE client through Better Auth's `createOAuthClient` (owner = the
user, `token_endpoint_auth_method: none`, `native` when a redirect is
loopback or a custom scheme). There is no suspend control yet; suspension
is an operator write.

At submit an OAuth caller's client is looked up in `gateway_apps` across
organizations: a suspended app is `403 APP_SUSPENDED`; an active one's id is
snapshotted on the payload (`appId`) and stamped on the hold and on every
charge line (`app_id`). A run started before PR 3 has no `appId` and
settles with null.

### Auth

An OAuth token is user-pays; one with no `client_id` is refused
(`GRANT_REQUIRED`), never treated as app-pays (`userPaysClientId`). An
`osk_` key or a cookie session is app-pays: no grant, no cap.
`GET /api/v1/gateway/grant` answers `{ payer: 'user', clientId,
monthlyCapMicros, spentMicros, heldMicros, remainingMicros, periodStart,
periodEnd }` for an OAuth caller (403 without a live grant) and `payer:
'app'` with the cap fields null for a key. `/api/v1` error `details` are
sent only for a `PublicApiError`.

## Shipped (PR 4)

### Code

- `src/gateway/apps.ts`: `MAX_APP_MARGIN_BPS` (5000),
  `MAX_APP_SKU_PRICE_MICROS` ($100), `APP_SKU_KEY_PATTERN`, and the consent
  arithmetic: `appliedMarginBps`, `boundedTerms`, `termsNeedApproval`,
  `termsOfView`. Client-safe; the consent page and Settings use it.
- Schema (migration `20261111232918_gateway_margin_and_earnings`: two new
  tables, three `ADD COLUMN`s, one index replaced; nothing is rebuilt):
  `gateway_apps.margin_bps`; `gateway_grants.accepted_margin_bps` and
  `accepted_sku_prices`; `gateway_app_skus`
  (`src/platform/server/db/schema/gateway-apps.ts`); `gateway_earnings`
  (`schema/gateway-earnings.ts`); `gateway_jobs`' idempotency index now
  `(organization_id, coalesce(oauth_client_id, ''), idempotency_key)`.
- `src/gateway/server/db/gateway-apps.ts`: `setMargin`, `saveSku`,
  `archiveSku`, `listSkus`, `getActiveSku`, `getTermsByOAuthClient`.
- `src/gateway/server/db/gateway-grants.ts`: the accepted terms on
  `getStanding` / `listStandings`, `setCap({ shownTerms })`, `acceptTerms`.
- `src/gateway/server/user-pays.ts`: `resolveUserPays` (app, grant, the
  margin to apply) and `holdCharge`, shared by submit, estimate and charges.
- `src/gateway/server/estimate-job.ts`, `app-charge.ts`, `manage-app.ts`;
  routes `gateway.jobs.estimate.ts`, `gateway.charges.ts`.
- `src/billing/server/db/billing.ts`: `settleReservation` writes the
  earning of each payee line; `getSettledCharge`; `creditEarning` (the
  sweep's one-batch credit).
- `src/billing/server/db/earnings.ts`: `scopedDb.earnings` (`byApp`,
  `cancelPending`) and the sweep's functions.
  `src/billing/server/mature-earnings.ts`: the sweep (`MATURE_EARNINGS_CRON`,
  `11 * * * *`).
- UI: the consent page (`routes/_app/oauth/consent.tsx`), Settings →
  Developer → Apps (`gateway/ui/gateway-apps-settings.tsx`: margin, SKUs,
  earnings) and → Authorized apps (`ui/settings/developer-authorized-apps.tsx`:
  current and approved terms, "Accept new prices").

### Margin and SKUs

An app's owners or admins set `margin_bps` (0 to 5000) and declare SKUs
(`key` unique per app, `name`, `price_micros` above 0 and at most $100,
`status` `active` | `archived`) in Settings. Both are server-side rows; no
request body or token claim can name a margin, a price or a payee.

At submit an OAuth caller's client is resolved once (`resolveUserPays`):
suspended → `403 APP_SUSPENDED`; no live grant → `403 GRANT_REQUIRED`;
otherwise the margin is `min(app.margin_bps, grant.accepted_margin_bps)`,
and none when the client is not a registered app or the payer is the app's
own organization. `appMargin: { bps, payeeOrganizationId }` (or null) is
snapshotted on the payload next to `appId`; the hold is
`gatewayCharge({ estimate, fee, appMargin }).totalMicros`, so the cap guard
counts the margin, and `settleGatewayJob` charges the same `appMargin`, so a
margin changed mid-run never reaches that run. An `osk_` key or a session
gets no margin.

### Consent

What the user agreed to is on their grant: `accepted_margin_bps` (integer)
and `accepted_sku_prices` (JSON `{ key: priceMicros }`). One read at submit
or charge (`getStanding`) has both; a SKU key is limited to
`[a-z0-9][a-z0-9_-]{0,63}`, so `json_extract(accepted_sku_prices,
'$."<key>"')` is also usable in SQL.

- **Approving.** The consent page lists the app's margin ("This app adds 20%
  on top of model costs, paid to <owner organization>") and active SKUs with
  their prices, and posts back what it showed. `setCap` records
  `boundedTerms(shown, current)`: the margin no higher than shown or than the
  app asks now, and each SKU both shown and active at no more than either
  price. A page that showed nothing records nothing. Changing the cap in
  Settings keeps the terms.
- **Lowering.** `setMargin` and `saveSku` lower every grant that accepted
  more, in the same batch; `archiveSku` removes the key from every grant. So
  what a grant holds is the lowest the user has seen since approving, and
  raising back needs approval too.
- **Raising** applies to no existing user until they approve again: through
  authorization with `prompt=consent` (an existing consent covering the
  scopes otherwise skips the page), or "Accept new prices" in Settings →
  Authorized apps (`acceptTerms`, live grant only, bounded the same way).
  Until then jobs carry the accepted margin, and a dearer or new SKU is
  `403 SKU_NOT_APPROVED`.
- A grant from before PR 4, or from before the client was registered, has
  `0` and `{}`: no margin, no SKU.

### App charges

`POST /api/v1/gateway/charges` `{ sku }` with an `Idempotency-Key`
(`createAppCharge`). Refusals, in order: an `osk_` key or session
`403 USER_PAYS_ONLY`; no key `400 IDEMPOTENCY_KEY_REQUIRED`; then a settled
charge under the key is returned as it is (`200`, `replay: true`, whatever
the body says); suspended app `403 APP_SUSPENDED`; no grant
`403 GRANT_REQUIRED`; not a registered app `403 APP_NOT_REGISTERED`; payer is
the app's organization `403 OWN_ORGANIZATION`; no active SKU
`404 UNKNOWN_SKU`; price above the accepted one (or none accepted)
`403 SKU_NOT_APPROVED`. The charge is held with `createReservation(price, {
idempotencyKey: app-charge:<client>:<key>, spendCap: { …, sku } })`, the
same guarded statement as a job, so the cap and the balance refuse it the
same way (`402 SPEND_CAP_EXCEEDED` / `INSUFFICIENT_CREDITS`). The same
statement also requires the SKU still active at the price read and the
grant's accepted price at least that, so a price change or archive racing
the charge is refused (`SKU_NOT_APPROVED` / `UNKNOWN_SKU` on a re-read), and
the charge is settled at once as
one `app_charge` line (`sku` set, payee the app's organization, attribution
client and app). A key already held for another price with no settle is
`409 IDEMPOTENCY_CONFLICT`. `201` answers the charge: its id is the debit's
transaction id.

### Earnings

`gateway_earnings`: one row per payee line (unique `charge_line_id`),
`payer_organization_id`, `payee_organization_id`, `app_id`, `amount_micros`,
`status` (`pending` | `matured` | `cancelled`), `available_at` (charge time
plus 14 days), `matured_at`, `transaction_id` (the `credit_earned` row),
`cancelled_at`. Every foreign key is `restrict`.

- **Written with its line.** `settleReservation` appends, after each payee
  line's `INSERT … SELECT`, an `INSERT … SELECT` from `charge_lines` by that
  line's id. The earning exists if and only if the line was written, at the
  line's amount after any short-capture cut. A payee line without an
  `appId` in the attribution is refused before anything is written.
- **Maturing exactly once.** The sweep lists due ids, then claims each with
  `UPDATE … SET status = 'matured' WHERE id = ? AND status = 'pending' AND
  available_at <= now RETURNING`: one caller gets the row, and a cancel after
  it finds nothing pending. The claimant credits the payee with
  `billing.creditEarning`: one `db.batch` writes the `credit_earned` row
  (user null, amount read from the earning row, only while it is `matured`
  and unlinked) under the idempotency key `earning:<id>`, unique per
  organization on `transactions`, the balance, the `earned` batch and the
  link, so a crash or a racing retry cannot move the balance without the
  ledger row (`addCredits` is several statements). A claim whose credit or link was lost (`matured`, no
  `transaction_id`, claimed over ten minutes ago) is retried by later sweeps
  under the same key: a credit that already landed is found and linked, not
  repeated.
- **Cron.** `MATURE_EARNINGS_CRON` (`11 * * * *`) is in the default block,
  `[env.production]` and `scheduled()`, which returns before the reconcile
  fall-through; `mature-earnings.test.ts` pins all three. It reads the raw D1
  handle, so it is on the `boundaries/no-raw-db` allowlist.
- **Developer view.** Settings → Developer → Apps shows, per app, pending and
  matured totals and the latest five rows (`earnings.byApp`), read-only.

### Estimate

`POST /api/v1/gateway/jobs/estimate` takes the submit body and runs the
submit's checks up to the price: the body, the model against the vias, and
for an OAuth caller `resolveUserPays` (so suspended and grant refusals are
the same). It returns `{ payer, kind, model, totalMicros, lines,
remainingMicros, fitsUnderCap }`; `lines` is `gatewayCharge` on the
estimate with this caller's margin. It reads the grant and the app and
nothing else: no row, no hold, no trigger, and no upload check (that
classifies and records a verdict, so it waits for the submit).

### Caller isolation

PR 3's reads and replays were scoped to the organization only, so one OAuth
app acting for an organization could read another app's jobs, or the
organization's `osk_` jobs, by id, and a colliding `Idempotency-Key` replayed
another caller's job. Now `GET /gateway/jobs/$id` (`getForCaller`) shows an
OAuth caller only jobs with its own `oauth_client_id` and an `osk_` key or
session every job of the organization; an idempotency key is looked up, and
unique, in the caller's own key space.

### Not yet (PR 4)

- No refund flow; `earnings.cancelPending` is its hook.
- No suspend control in Settings; suspension is an operator write.
- Earned credits get the same batch expiry as purchased ones
  (`calculateExpiryDate`).

## Not in this stack

- Moving the main app's own workflows onto the gateway. Roughly twenty
  workflows call the provider modules directly today; they move one domain at
  a time once the contract is stable.
- Audio and LLM kinds, result webhooks, streaming.
- Extraction to a separate Worker.
- Cash payouts. They need Stripe Connect and legal review first.
- Reconciled pricing for the native vias. Margin on xAI, Google, Ark and
  ElevenLabs spend rests on the static price cards until that exists.
