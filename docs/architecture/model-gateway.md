# Model gateway

The gateway is OpenStory's own model API. It runs inside the main Worker in
front of fal, BytePlus (Ark and Seed Audio), Gemini, Grok, ElevenLabs and the
text providers. A request body is the provider's own, checked against the
model's input schema and sent unchanged; the job, the price and the result URLs
are ours. The price is the model's rate card from modelschemas.com, held before
the call and charged from the usage after it. The product's own generations go
through the same code in-process; a self-hosted install with one OpenStory key
reaches it over HTTP. Whatever the gateway cannot hold yet still runs on the
direct provider path (§ Still on the direct path).

## Surface

| Method and path                           | Purpose                                                      |
| ----------------------------------------- | ------------------------------------------------------------ |
| `GET /api/v1/gateway/models`              | Every priced model, with its submit path                     |
| `POST /api/v1/gateway/{provider}/{model}` | Submit a media job. Returns `202` and the job                |
| `GET /api/v1/gateway/jobs/$id`            | Status, result URLs and the charge lines (`?wait`)           |
| `POST /api/v1/gateway/chat/{model}`       | One text run, streamed as AG-UI events, held and charged     |
| `POST /api/v1/gateway/uploads`            | Store and likeness-check one input file; answers its own URL |

- **Body in is exact, job out is ours.** Each provider queues and polls
  differently, so the answer is one job shape for all of them, and result URLs
  are our R2 copies, stored in the step that received them (#1645).
- `{provider}` is a modelschemas provider id (`fal`, `byteplus`, `gemini`,
  `grok`; `elevenlabs` is in-process only); `{model}` is that provider's own
  model id (a fal id keeps its slashes). A job is stamped with the provider's
  `via` at submit and never hops between providers.
- **The price is the rate card** (modelschemas `pricing`), never the provider's
  billed units. A model with no card, or a request the card cannot price before
  it runs, is refused.
- Kinds: `image`, `video`, `audio` (jobs) and text (the chat endpoint and the
  in-process meter, no job row).
- `Idempotency-Key` on submit and upload makes the trigger and the hold
  idempotent.
- OAuth callers need the `models:invoke` scope on every `/api/v1/gateway`
  request, reads included. `osk_` keys are unscoped; the key's organization
  pays. The token's client is recorded on the job and its charge lines.
- The routes (`src/routes/api/v1/gateway.*.ts`) are thin; the logic is in
  `src/gateway/server/`.

## Code map

- `src/gateway/schema.ts`: providers and their vias, stored input, output and
  error types, `jsonObjectSchema`, `HOSTED_MODEL_ID`. Client-safe.
- `src/gateway/charge-lines.ts`: `gatewayCharge`, the lines of a charge. Pure
  and client-safe; the hold and the settle use the same function.
- `src/gateway/product-models.ts`: `productGatewayModels()` and
  `productTextModels()`, every model the product calls: what the snapshot holds
  and the coverage check walks.
- `src/gateway/server/catalog.ts`: `getGatewayModel` (model, input schema, rate
  card) and `listGatewayModels`; `unholdableReason`.
- `src/gateway/server/price.ts`: `priceGatewayJob` (the card against the
  request and, at settle, the usage), `COUNT_FIELDS`, `heldOutputs`.
- `src/gateway/server/providers.ts`: `GATEWAY_DRIVERS`, one `configured`,
  `answersAtOnce`, `start` and `poll` per provider; `extractAssetOutputs`.
- `src/gateway/server/phases.ts`: the run of a held job as functions a caller
  runs in its own steps: `claimAndStartGatewayRun`, `startGatewayRun`,
  `pollGatewayRun`, `settleGatewayRun`, `finishGatewayRun`,
  `releaseGatewayRun`.
- `src/gateway/server/submit-job.ts`: `holdGatewayJob` (validate and hold),
  `submitGatewayJob` (the public submit), `gatewayHoldMicros` (the hold on an
  estimate, which quotes read), the media URL gate (`gatedUrls`),
  `UPLOAD_RIGHTS_CHECKED`.
- `src/gateway/server/settle.ts`: `settleGatewayJob`, the one place a media job
  is charged.
- `src/gateway/server/platform-fee.ts`: `gatewayPlatformFeeBps`, the fee read
  from `GATEWAY_PLATFORM_FEE_BPS`.
- `src/gateway/server/route.ts`: `resolveGatewayRoute`, `gatewayRunRoute`,
  `gatewayCannotRun`, `hostedRouteFor`; the routing rule for media.
- `src/gateway/server/text.ts`: `withTextGateway`, `openstoryText`, `forCall`;
  the text meter.
- `src/gateway/server/chat.ts`: the public chat endpoint.
- `src/gateway/server/uploads.ts`: the public upload endpoint.
- `src/gateway/server/remote-config.ts`: whether this install runs providers on
  the hosted gateway, `hostedFetch`, the `remote:` handle.
- `src/gateway/server/storage.ts`: `storeGatewayOutput`, output keys and
  extensions.
- `src/gateway/server/read-job.ts` and `api-documents.ts`: the
  organization-scoped job read and the response documents
  (`GatewayModelsResult`, `GatewayJob`) with their links.
- `src/gateway/server/platform-credentials.ts`: `platformOnlyCredentials`,
  `withPlatformLlmKey`.
- `src/gateway/server/adapter/index.ts`: the `openstory` TanStack AI adapters
  (`openstoryImage`, `openstoryVideo`, `openstoryVideoStatus`,
  `openstoryAudio`) over a `GatewayTransport`.
- `src/gateway/server/adapter/in-process.ts`: `inProcessGateway`,
  `inProcessPoller`, `releaseInProcessJob`.
- `src/gateway/server/adapter/http.ts`: the HTTP transport to the hosted
  gateway; `gatewayTransport` and `gatewayPoller`, the one place a call site
  turns a route into a transport.
- `src/gateway/server/adapter/http-text.ts`: `hostedTextAdapter`.
- `src/gateway/server/refresh-models.ts`: the daily snapshot refresh.
- `src/gateway/server/db/gateway-jobs.ts` and `db/gateway-models.ts`:
  `scopedDb.gatewayJobs` and the stored snapshot.
- `src/gateway/server/coverage.ts` and `scripts/check-gateway-coverage.ts`: the
  coverage check.
- `src/gateway/server/reconcile-gateway-jobs.ts`: the stuck-job sweep.
- `src/gateway/server/workflows/gateway-generation-workflow.ts`:
  `GatewayGenerationWorkflow` (binding `GATEWAY_WORKFLOW`, trigger `/gateway`),
  the public submit's run.
- Tables: `gateway_jobs`, `gateway_models`, `charge_lines`
  (`src/platform/server/db/schema/`).

## A request

```bash
POST /api/v1/gateway/fal/fal-ai/phota
{ "prompt": "Mara, a ferry mechanic, wipes her hands on a rag in the engine room" }

POST /api/v1/gateway/grok/grok-imagine-video-1.5
{ "prompt": "…", "duration": 6 }
```

- The body is validated with `z.fromJSONSchema` against the model's input
  schema. Nothing is defaulted, snapped or renamed: what the schema refuses is
  a `400`, and what it accepts is sent.
- Three refusals keep the price honest (`validatedBody`): on Grok and BytePlus,
  which read the model from the body, the path's model is always written there,
  and a body naming another model is refused; a top-level field the schema does
  not name is refused, not dropped; and a count field (`COUNT_FIELDS` in
  `price.ts`: `num_images`, `sampleCount`, `numberOfImages`, `numberOfVideos`,
  `batch_size`, `num_samples` and the rest) above 1 that the card does not
  price is refused, as is one above 1 at any depth below the top level, and any
  count that is not a whole number of at least 1. A count is a number or
  string, never an object, and nothing under a JSON Schema keyword
  (`properties`, `examples`, `default`, …) is read as one, so a tool or
  response schema with a property named `n` passes.
- Only as many outputs as the request's count (else one) are stored and
  charged; extras are dropped with a warning (`heldResult` in `phases.ts`),
  unless the card charges each output from usage (an output lever: output
  tokens, megapixels, seconds, generated images). A card whose only usage
  lever is an input keeps the cap.
- **The media URL gate** (`gatedUrls`). A media string must be a plain
  `http(s)` URL, or one of our own `/r2/` paths. It must read back from the URL
  parser as written, up to scheme and host case, the root slash and
  percent-encoding; the parser's href is what the likeness check sees, and the
  body goes to the provider as sent. Anything a parser would still fetch is
  URL-like and checked: `https:host`, `https:/host`, backslashes, a leading
  control character, a tab, LF or CR inside an `http`, `https` or `ftp` URL
  (the parser drops them), a default port, a dot segment. `data:` and `blob:`
  in any spelling, a protocol-relative URL, and any other scheme written with
  `//` are refused. Prose is not: `http: the old protocol` (no host follows
  the scheme) and `Label:\n//note` (another scheme, tested as written). Every URL goes through the upload rights check
  (`requireCheckedUploadRights`) before any provider sees it. Inline media is
  refused on the public endpoint: the check is keyed on a URL.
- An image the check finds a real person in is `400 ATTESTATION_REQUIRED`: the
  public endpoint has no portrait attestation. A raw URL is classified on first
  use, an organization's own upload by its existing verdict, and another
  organization's file is refused.
- A Seed Audio voice cloned from a clip (`references[]` with `audio_url` or
  `audio_data`) is refused on the public endpoint: the likeness check cannot
  hear whose voice a clip is. Stock and described voices work.
- **Usage in the card's names.** Gemini's `usageMetadata` goes to the
  evaluator's `normalizeUsage` as Google sends it (prompt tokens to
  `input_tokens`, image tokens to `image_output_tokens`, the rest plus thinking
  to `output_tokens`). fal results carry no usage: the driver reports
  `megapixels` (the sum of `width × height / 1,000,000` over the result's
  images; none if any image has no size) and a video's length as `duration`,
  never fal's billed units. BytePlus reports `completion_tokens`, Seed Audio
  `original_duration`.

## Job lifecycle

`queued` → `running` → `succeeded` | `failed`. The row is written only through
`scopedDb.gatewayJobs`; it has no selection pointer, so it is a
`claim-discipline` exception like `generated_assets`.

1. **Hold** (`holdGatewayJob`): the driver is configured, the body checks, the
   account passes the generation gate, every URL passes the rights check, the
   card prices the request, the row is inserted and the hold reserved. A
   refused request leaves no row and no hold.
2. **Start:** `claimAndStartGatewayRun` claims the row (`markRunning`) and
   sends the body; a replayed start that finds the row already `running` fails
   and releases rather than send again. A provider that answers at once has its
   media stored to R2 inside that step. A queued job has its provider id
   stamped, then is polled; the poll that sees it finish stores the media.
   Bytes never cross a `step.do`.
3. **Tail:** `record-provenance` (`gateway_job`), then `settle`, which records
   the outputs, prices the card with the usage, charges and marks the job
   succeeded in one step (`finishGatewayRun`: outputs, then the charge, the one
   place that order lives). A settled job zeroes the rest of its own hold in
   that step. Nothing runs after it.
4. **Failure:** `releaseGatewayRun` zeroes the hold (only when the run owns
   it), then `markFailed` writes `{ code, message }` (`CONTENT_REJECTED` for a
   content refusal, else `GENERATION_FAILED`; `NOT_STARTED` when the submit's
   trigger itself failed).

**The start-error rule** (`claimAndStartGatewayRun`, for the public run and the
in-process transport alike). A driver either answers at once (`answersAtOnce`:
Seed, Ark images, Grok images, Gemini, ElevenLabs) or queues a job (Ark tasks,
Grok video, fal).

- A 4xx fails and releases.
- A 429 from any start, or the origin's own 500 or 503 from a start that
  answers at once, ran nothing: the job goes back to `queued` with its hold and
  the retried step sends it again under the same key.
- Anything else fails and releases and is never sent twice: any 5xx from a
  queued start, a proxy's 502, 504 or 52x (Cloudflare in front of xAI or the
  Seed edge, which can follow a request that finished and was billed), a
  timeout or a dropped connection. A 500 or 503 from a queued start fails at
  once; the rest fail when the retried step finds the job `running` with no
  provider id. fal's SDK errors carry `status`, not `statusCode`, so a fal
  submit error takes that last path.

A run does not resubmit after a content flag or Ark's InternalServiceError;
the product's own callers decide that (§ Video).

- **Public error messages.** The job document answers a fixed message per code
  (`GATEWAY_ERROR_MESSAGES`), never the stored text. The row and the logs keep
  the provider's own text.
- **Missing platform key.** The hold refuses with `503 PROVIDER_NOT_CONFIGURED`
  before the body checks and the hold when the driver's `configured` says it
  cannot run the endpoint: the platform key (`FAL_KEY`, `XAI_API_KEY`,
  `GEMINI_API_KEY`, `ARK_API_KEY`, the Seed Speech key for `tts/create`,
  `ELEVENLABS_API_KEY` for `v1/music`) and, for the native drivers, the E2E
  gate.
- **Stuck jobs.** The 5-minute cron (`*/5`, the reconcile branch of
  `scheduled()`) runs `reconcileGatewayJobs`: `queued` or `running` jobs with a
  run id, untouched for 5 minutes, oldest first, 100 a pass. Each whose run the
  engine reports over is ended as its `onFailure` would have: `markFailed` (a
  charged job still ends `succeeded`), then its hold zeroed, and a warning
  logged. A run still in flight, or one the engine cannot read, waits for the
  next pass. A job with no recorded run id is not swept. A borrowed run
  reservation is not on the row, so the sweep never zeroes it.

### Idempotency

`Idempotency-Key` (≤ 255 characters) is unique per organization on
`gateway_jobs`. The key binds the job and the job binds the rest: the hold key
is `gateway:<jobId>`, the trigger's `deduplicationId` is `gateway-<jobId>`, the
settle key is `gateway:<jobId>:settle`. A replay returns the first job only
when the provider, model and body match it (field order aside); a different
request under a used key is a `409` (`requireSameRequest`, at the replay check
and in `holdGatewayJob`). A replay still counts against the rate limit. A key
whose first submit was refused before the hold (credits, a bad upload) is free
again. A key whose trigger failed (`NOT_STARTED`) is spent.

Inline media on the row (`audio_data`, `inlineData` and the other inline keys,
and any `data:` URL over 256 characters) is stored as `{ sha256, length }`,
never the bytes, so a 30 second clip stays under D1's 2 MB row; a replay is
compared on the digest, and the provider still gets the whole body.

## The openstory adapter

One `openstory` TanStack AI adapter per kind (`name: 'openstory'`):
`openstoryImage`, `openstoryVideo` with `openstoryVideoStatus`, and
`openstoryAudio`, each over a `GatewayTransport`: `submit(body,
idempotencyKey)` holds and starts, `poll(handle)` polls once. `modelOptions` is
the provider's own body, built by the product's existing builders and sent as
it is.

- TanStack's `prompt` is required by its types and ignored: pass `''`. `size`,
  `duration` and `numberOfImages` are refused (`NonRetryableError`): put them in
  the body. The gateway never builds a body.
- **Images and audio** submit and poll to the end inside one call
  (`runGatewayToEnd`). **Video** maps onto `generateVideo` (hold and start),
  `getVideoJobStatus` (one poll) and `getVideo` (the URL stored by the poll
  that saw the job finish), across the caller's steps.
- Rate cards, holds and usage have no place in the TanStack interfaces; the
  charge stays on the gateway job, read back by its id where a caller shows it
  (`readGatewayCharge`).
- A succeeded job with no outputs throws; it never answers with zero media.
- **Refusals** (body, price, credits, missing key, a key reused for another
  body) are `NonRetryableError`: the step does not retry the answer.
- **Idempotency.** The caller passes a replay-stable key per call, e.g.
  `${instanceId}:${stepName}` plus the index in a fan-out. A retried step, on
  the same transport object or a new one, finds the same job and the same hold,
  so a generation is charged once however often a step runs.
- **Replays.** A held job that already exists is never started twice: a
  succeeded one returns its stored outputs, a failed one its error, a running
  one resumes polling its stamped provider job, and a running one with no stamp
  (the provider may have it) is failed and its hold let go. Only the attempt
  whose `markRunning` flipped a queued row starts it.

### In-process transport

`inProcessGateway({ scopedDb, model, runId, store, uploadRightsChecked,
reservation, wireBody })` runs the phases inside the caller's own step, on its
`WorkflowScopedDb`, with the model the caller snapshotted at the trigger
(schema and card are never fetched mid-run). It records the caller's run id on
the job, for the sweep.

- **The handle.** A queued job's id is the held `GatewayRun` as JSON plus the
  provider's job id, so a poll step reads no row to know what to poll. A job
  that answered at submit has a `done:` handle naming its job id and outputs
  (`doneVideoJob`). Callers must not parse a handle; the HTTP transport's is
  opaque.
- A poll first reads its own job by id (`scopedDb.claims.gatewayJobs.getById`):
  a job that already ended answers from the row, so a retried poll never stores
  a second copy or charges again. A poll that stores and then fails to finish
  leaves at most one orphaned R2 object; the job is charged once.
- **The stored body and the wire body.** A job is held, checked and replayed on
  a body whose stored URLs are absolute and stable across attempts
  (`stableMediaBody`: the CDN URL, else the app's own `/r2/` route). Just before
  the start, `wireBody` makes the body the provider can fetch (fal storage
  upload via `fetchableFalBody`; `toDataOrCdnUrl` for xAI), so a failing upload
  strands no hold and a retried step, whose fresh upload is a new URL, still
  replays its own job. Both rewrite only a URL we serve (`/r2/<key>` or the
  app's origin) whose key the run's organization owns (`storedUrlOwnedBy`, the
  check `isCheckable` uses); another host's `/r2/` path is sent as it came.

### HTTP transport

`src/gateway/server/adapter/http.ts`, for a route `remote` (§ Routing). It
never touches the install's database: no hold, no settle, no deduction.

- **Submit:** every local `/r2/` string in the body becomes a hosted URL first
  (`withUploadedMedia`: a hosted output goes back by its hosted URL, any other
  file is uploaded through `POST /gateway/uploads`, audio without a hosted
  record is refused before anything is sent), then `POST
  /api/v1/gateway/{provider}/{model}` under the call's Idempotency-Key.
- **Poll:** `GET /api/v1/gateway/jobs/{id}?wait=20s`. The handle is
  `remote:<hosted job id>` (`remoteHandle`), never the run as JSON.
- **Results:** each output URL is copied into the install's storage through the
  caller's `store`, and its hosted URL recorded (§ Uploads). A retried poll
  copies again (one orphaned object at most); the charge is the hosted job's,
  once. A clip's `costMicros` is read from the hosted job document for display
  (`remoteJobCharge`), never debited; an outage reads null and never fails the
  run.
- **Only the run's own files leave.** A local `/r2/` key whose owner segment is
  not the run's organization is refused before storage is read (`isCheckable`).
  A string is read as this install's file only in exactly the stable form of
  its own key (`localStorageKey`).
- **No path can be retargeted.** A model id must match `HOSTED_MODEL_ID` and
  each segment is encoded (`hostedModelPath`); a job id must be a ULID, both
  when the hosted side answers it and when a handle is polled.
- **The key is a secret.** `OPENSTORY_API_KEY` is read inside the call that
  spends it, sent only as `Authorization: Bearer`, never on a payload, in a URL
  or a log. `hostedFetch` refuses redirects, so a hop cannot carry the key.
- **Never a fallback.** A hosted refusal (any 4xx but 429: `400`,
  `402 INSUFFICIENT_CREDITS`, `404 Unknown model`, a card that cannot price, a
  real person) is a `NonRetryableError` reading `CODE: message` as the hosted
  side wrote it. A 429 or 5xx is left to the step's retry under the same key.
  Nothing is tried on a local key.
- A timed-out remote clip is not released: the hosted job ends and is charged
  there.

### Trusted callers

The public endpoint refuses inline media and runs the likeness check on every
URL. `holdGatewayJob` takes `rights`: either `{ scopedDb, request }`, which runs
those checks, or `UPLOAD_RIGHTS_CHECKED`, a unique symbol an in-process caller
passes to say it ran `requireUploadRights` itself. A JSON body cannot carry a
symbol and `submitGatewayJob` always passes the request, so the public endpoint
can never skip the checks. `inProcessGateway` requires it as a named argument.

`upload-rights-checked.test.ts` resolves every import of `submit-job.ts` and
fails unless the file reaching the symbol is on its allowlist, and fails if an
allowlisted file passes it on. The callers and why their inputs are checked:

- Stills (`image-generation.ts`): references are uploads classified when saved
  (`requireUploadRights` in `media-upload.ts`, location and element attach,
  describe upload), Studio uploads checked at the click, or media we generated.
  An upload saved before the ledger (#1581) has no verdict and is refused on
  this path (`requireUploadRights` on `needsLikenessCheck` refs). Gemini stills
  go inline by design (`geminiStillSource`).
- Video (`video-job.ts`): Studio checks every upload at the click; motion's
  stills and sheets passed the gate when saved, its reference clips in
  `check-reference-clip-rights`.
- Audio (`audio-gateway.ts`, used by `seed-audio.ts`): Seed voice clips are made
  from text, and a mic take is the user's own recording made in the app.
- The Models page run (`asset-generation-workflow.ts`).

A new caller is added there on purpose; no route or MCP tool may be.

## Routing

The route is decided once, before any job exists, and snapshotted on the
payload or a step's checkpoint. It is a routing rule, not a fallback: a job
stamped `openstory` fails as a gateway error and is never retried on another
via. A poll follows the stamp (a missing stamp is fal, a missing endpoint stamp
the catalog id), so a job in flight finishes where it went.

`resolveGatewayRoute({ scopedDb, provider, modelId, body })` answers one of:

1. **Own key → direct.** The organization has a usable key for the provider
   (`OWN_KEY`: fal, Google for Gemini, xAI for Grok; BytePlus and ElevenLabs are
   platform-only). Today's direct path, unbilled by the gateway.
2. **Platform key and a holdable card → `openstory`.** This server has the
   provider's key (`GATEWAY_DRIVERS[provider].configured`), the model is in the
   stored snapshot (`getSnapshotGatewayModel`, so a modelschemas outage cannot
   stop a trigger) and its card can hold the body (`gatewayCannotRun`: the
   schema and the card, no read). In-process.
3. **No key here and `OPENSTORY_API_KEY` set → `remote`.** A key on this server
   is read per provider even with no snapshot row (`serverHasKey`), so an
   install's own provider key always wins. The hosted side checks the schema
   and the card, so the install needs no snapshot to route. E2E stays on the
   mocks unless `OPENSTORY_GATEWAY_URL` is set too.
4. **Else → direct, with the reason** (no snapshot row, an unholdable card, a
   body the schema refuses, a rule below). The reason is logged.

The run reads its route only through `gatewayRunRoute`: the snapshot plus the
pure body check, so a retried step takes the same route. A payload persisted
before routes existed has none and runs direct.

### Product stills on the gateway

The trigger resolves `gatewayRoutes` (`imageGatewayRoutes`,
`src/stills/server/image-gateway-routes.ts`) for every image model the product
can select (`imageRouteTargets`, through `resolveImageVia`, the function the
direct path uses): native Grok by its xAI id; fal by its text-to-image endpoint
and its edit endpoint (`EDIT_ENDPOINTS`), so a still with references is decided
on the edit card. Ark Seedream and native Gemini have no target and go direct:
Ark registers a real person's portrait as an account-wide asset before the
call, which the product owns (`byteplus-ark.md`).

`generateImageWithProvider` is the one place the route is applied
(`gatewayImageRequest`). Each attempt is its own job and hold under
`<runId>:<stepName>`; the softening loops name a step per attempt, and the fal
content-flag rescue to `IMAGE_CONTENT_FALLBACK_MODEL` is decided again for that
model. A provider refusal reaches `isContentRejectionError` unchanged, so
softening runs as before. The workflows skip their image deduction on an
`openstory` still.

Children inherit `gatewayRoutes` from their parent like `reservationId`: Studio
images, shot image and variant regenerations, character and location sheets,
the sequence pipeline (storyboard and continue, Update stale, smart retry, add
model). A root merges its image routes into any it was given. Recast
location's `RegenerateShots` children, shot previews and Replace element's
children carry no routes and go direct.

### Video

Motion has six triggers and a content-flag rescue that swaps the model mid-run,
so its route is resolved in the run, in its own step: `route-motion<tag>`
(studio `route-video<tag>`) after the via step, before the submit
(`routeVideoJob`, with the own-key check through
`scopedDb.liveRead.apiKeys.hasUsableKey` and the stored snapshot). The step's
checkpoint (the route, the model as JSON text) is what every retry of the
submit reuses. `src/motion/server/video-job.ts` is the one send, poll and price
path for motion and Studio video.

- The submit captures the body the provider adapter would send (its one
  request, intercepted; nothing leaves) and applies `gatewayRunRoute`. A
  submit whose target is not the routed one goes direct (`not routed at the
  trigger`).
- A rescue gets its own `-rescue` route step and submit key; Ark's
  InternalServiceError gets one new job (`-internal`); neither reuses a job
  stamped for the old attempt.
- Direct by rule: own key, an unholdable model or body, an Ark draft or its
  final (`isArkDraftTask`: Ark task ids the gateway does not hand out), scripts.
- Failures read as the provider's: `isSeedanceInternalServiceError` and
  `explainSeedanceFailure` ask `videoJobProviderVia(job)`, the provider behind a
  gateway job. The in-process poll passes the provider's `code: message`
  through, so `QuotaSharedPoolExceeded` still reads as busy.
- `videoCostFromUsage` and the `price-motion-generation` / `deduct-credits`
  steps run only on a direct via.
- **A cancelled clip is still charged.** Cancel is data-only; the provider job
  is not stopped, so the gateway charges it when it finishes.
- A run that times out after 30 minutes ends its job itself
  (`releaseTimedOutVideoJob`, a `release-motion-job<tag>` step) before it
  throws; a failed release is logged, never thrown.
- Packed clips: one run, one submit, one job, one charge.
- `LipsyncWorkflow` stays direct (its card has no estimate) and builds a fal
  client per step (`lipsyncFalClient`): a shared `fal.config` could send one
  run's organization key on another's request.

### Audio on the gateway

Seed takes and Music read the run's `gatewayRoutes`; the audio root triggers
resolve `AUDIO_ROUTE_TARGETS` (`src/audio/gateway-targets.ts`) and children
inherit them. Both go through `runAudioOnGateway`
(`src/audio/server/audio-gateway.ts`), which passes the run's reservation.

- **Seed takes.** A take is recorded by a `SeedRecorder` (`seedRecorderFor`):
  `gatewaySeedRecorder` holds and charges each take in-process,
  `platformSeedRecorder` calls Seed Speech direct and the caller books
  `seed-audio`. One key per take, `${runId}:${step}:${take}`, no attempt: a step
  retried after Scribe, isolation, R2 or D1 throws gets its charged takes back.
  A take that fails the transcription check is retaken in the step under the
  next take number. The WAV is stored in the step that recorded it and read
  back to transcribe and cut. Pacing stays on the BytePlus governor
  (`acquireSeedSpeechToken`), since the rate cap is the account's. Scribe and
  isolation stay ElevenLabs ledger lines.
- **ElevenLabs is in-process only.** The platform key reaches the whole shared
  account, where saved voices are account-wide slots the product owns
  (`voiceProviderOf`, `releaseVoiceIfUnreferenced`). The public endpoint refuses
  every ElevenLabs model, and the driver calls only `ELEVENLABS_ENDPOINTS`
  (`v1/music`). A 429 (the account's concurrency cap) is resent by
  `retryOnRateLimit`; an `audio/*` answer is one media file. No ElevenLabs model
  has a card yet, so every call runs direct today.
- **A body is JSON only.** A query parameter has no place in it and the driver
  never moves a field out of the body. Voice design needs
  `output_format=mp3_44100_128` and dialogue `output_format=wav_44100`, so
  neither is routed even once a card exists; Scribe, isolation and
  speech-to-speech take a multipart file. Both are limits of our design, not
  gaps in modelschemas.

### LLM calls

Decided where the key is: `resolveLlmKey`, wrapped by `withTextGateway`
(`src/gateway/server/text.ts`) in `createScopedDb` (§ Text). With no
LLM key here and an OpenStory key, `resolveLlmKey` answers `via: 'openstory'`
(`getHostedLlmKey`) and `createAdapter` streams the hosted chat endpoint
(`hostedTextAdapter`).

### The Models page

`createGeneratedAsset` (`src/models/server/generated-assets.ts`) picks the route
at the click and puts it on the payload:

- **`openstory`** (no own fal key): `holdGatewayJob` with the request's likeness
  check under `asset:<assetId>`. The asset row is stamped `provider:
  'openstory'` and `gatewayJobId`. `AssetGenerationWorkflow` runs the adapter
  over `inProcessGateway` with the same key, so it finds the click's job and
  hold. The charge is shown under the run once it settles
  (`getGeneratedAssetWithCharge`). A failed run lets the hold go.
- **`fal`** (the organization has a usable fal key): the direct path, unbilled.
  Schema, account and likeness checks at the click, no hold, no job. The run
  uses the fal driver with the organization's key and fails rather than spend
  the platform's; fal's request id is checkpointed before any poll.
- **`remote`** (no key here for the provider, an OpenStory key;
  `hostedRouteFor`): no local job or hold. The run sends the body over HTTP
  under `asset:<assetId>`. The activity is the client's word on this route; the
  hosted side runs the model it names.

A model the gateway cannot hold is listed with the reason
(`unholdableReason`); on an own fal key it still runs. A run's kind is the
model's, never the client's `activity`. `AssetGenerationWorkflow` stays as the
runner for the own-key and remote routes (§ For the maintainer).

## Holds

- The hold is every line of the charge on the card's estimate:
  `gatewayHoldMicros(estimate)` = `gatewayCharge(estimate, fee).totalMicros`.
  Quotes read the same function, so quote equals hold.
- A hold is `billing.createReservation` with no own-key skip.
- Insufficient credits at submit is `402 INSUFFICIENT_CREDITS` and leaves no
  row, so the same key can be sent again after a top-up.
- **No double hold: the run-reservation rule.** A run that already reserved for
  its work at its trigger (the pipeline envelope, a shot or sheet trigger,
  motion, Studio video, audio roots) passes it as `inProcessGateway({
  reservation: { id } })`. The hold still prices the card, refuses what it
  cannot price and writes the job row, but takes no second reservation: the
  settle captures the card's charge against the run's, so a balance that
  covers the run is not asked to cover the job again. Such a run carries
  `ownsReservation: false`: a failed job is marked failed without zeroing the
  run's reservation, and the row records none, so the sweep cannot zero it.
  Only an in-process caller can pass one; the public submit and the Models page
  always hold their own.
- A run with no reservation holds per job. Studio on an `openstory` still takes
  no trigger hold, so each still shows its own hold in the ledger.
- A capture renews the reservation's `RESERVATION_TTL_MS` (6 hours); a 30-minute
  poll window sits well inside it.
- **Preflight on a one-key install.** A run's `requireCredits` and
  `reserveRunCredits` skip the local check and hold only when no call of the run
  can spend here: an OpenStory key and no platform key at all
  (`onlyHostedGatewaySpends`). With any platform key the run holds its whole
  estimate as before, remote calls included, and releases the rest at its end.
  Platform-only work (`providers: []`) always holds.
- **Quotes for stills.** `imageQuotePricing` gives a trigger the fal price map
  with each endpoint on an `openstory` route carrying `gatewayHolds`, the hold
  per shape (`gatewayHoldKey(aspectRatio, resolution, numImages)`) for every
  aspect ratio, resolution and count up to 4, generation with no references
  and edit with one. `estimateImageCost` reads the hold for the request's
  shape; a shape with no hold runs direct and keeps the fal price. An endpoint
  with no fal row is never given one. Signed-in pages read the same map through
  `getOrganizationFalPricingFn`; `getCatalogFalPricingFn` is for signed-out
  pages. Preflight, Continue, Update stale, smart retry, sheet references and
  the freeze-plan gate all read it, so the run envelope reserves what the
  gateway charges. Plan envelopes price every still with no references (which
  shots carry references is not known per unit), so where the generation hold
  is higher a cast-heavy plan over-reserves and settle releases the rest.

## Money

A settled charge is one wallet debit and one or more **charge lines**
(`charge_lines`, written in the same D1 batch as the debit by
`billing.settleReservation`).

| Line kind       | Payee              | Amount                             |
| --------------- | ------------------ | ---------------------------------- |
| `provider_cost` | platform           | the card's price for the call      |
| `platform_fee`  | platform           | `GATEWAY_PLATFORM_FEE_BPS` of cost |
| `app_margin`    | app's organization | not built (§ Not built)            |
| `app_charge`    | app's organization | not built (§ Not built)            |

- The charge is the lines on the card's price for the request plus the usage
  the provider reported; a card that reads no usage charges exactly the hold.
  When the card refuses the reported usage, the lines of the estimate (the
  hold) are charged and a missing cost reported, never settled free.
- Each line is rounded half up to a whole microdollar on its own (basis points
  in bigint, exact at any safe amount) and the total is their sum. Lines of
  zero are not written.
- The lines of a charge always sum to the debit, and exist only for a debit
  that happened. A line selects from the transaction row its batch inserted and
  takes `min(amount, debit − lines ahead of it)`.
- **Short capture.** A charge above the hold grows the hold while the balance
  covers it. Otherwise the debit is short; lines fill in `inFillOrder`
  (`provider_cost`, `platform_fee`, `app_charge`, `app_margin`) and the rest is
  cut: the platform paid the provider, and a payee never earns on money the
  payer did not pay. The shortfall is reported (`billing_skipped_deduction`),
  never written as a line.
- A replay of the settle key writes nothing and returns the original debit and
  lines. A missing reservation writes nothing. A negative or fractional line,
  or lines past a safe integer, are refused.
- The table: `organization_id` (payer), `transaction_id` (the `credit_usage`
  debit), `kind`, `amount_micros` (> 0), `payee_organization_id` (null is the
  platform), `gateway_job_id`, `oauth_client_id`, `app_id`, `sku` (a text call's
  `<provider>/<model id>`), `created_at`. Every foreign key is `restrict`.
- **The job document** shows `charge: { totalMicros, lines }` once the job
  succeeded, only lines the reading organization paid. A job that settled with
  no debit reads `{ totalMicros: 0, lines: [] }`.
- `settleGatewayJob` refuses a result that reports `usedOwnKey`.
  `platformOnlyCredentials` resolves through `resolvePlatformOptionalKey`, which
  reads env, never the organization's key row; the run never touches
  `scopedDb.credentials`.

### A charged job never reads failed

- The `settle` step records the outputs before the charge, charges, and marks
  the job succeeded; a retry replays the charge and writes the success again.
- `markFailed` first promotes a job that has charge lines and outputs to
  `succeeded`, at what its lines sum to. So an `onFailure` after a charge, or a
  submit's `NOT_STARTED`, cannot fail a charged job.
- A succeeded job with lines has `costMicros` equal to their sum:
  `markSucceeded` rewrites it from the lines, because a settle re-run after a
  first attempt that debited nothing can debit after a top-up.
- The job document shows `outputs` only once the job succeeded.

### A lost trigger reply

`triggerWorkflow` can throw after the instance was created. The submit then
marks the job `NOT_STARTED` and zeroes the hold, but the run still executes and
charges (the capture grows the zeroed hold when the balance covers it). So a
`NOT_STARTED` row stays writable by its run: `markRunning` revives it, and
`stampProviderJob`, `recordOutputs`, `markSucceeded` and `markFailed` accept
it. The job ends `succeeded` with its lines, or failed with the run's own
error.

### The platform fee

`GATEWAY_PLATFORM_FEE_BPS` is configuration: basis points of provider cost,
read by `gatewayPlatformFeeBps` (`src/gateway/server/platform-fee.ts`). A whole
number from 0 to 10000; anything else throws. It is a wrangler var in all
three blocks of `wrangler.jsonc` (default, production, test; vars are not
inherited), typed by `worker-configuration.d.ts`; unset only in unit tests,
where it is 0. `platform-fee.test.ts` parses every block's value, so a bad one
fails CI before a deploy. The value is the maintainer's; it ships at 0.

- **Applied in one place.** `gatewayCharge` computes every charge's lines from
  the provider cost and the fee. A media hold reads the fee once
  (`holdGatewayJob`), stores it on the job row (`gateway_jobs.platform_fee_bps`)
  and snapshots it on the run payload (`platformFeeBps`), so a replayed key
  and the settle both use the fee the hold was taken at, never the current
  setting. The text meter reads it at the hold and at the charge.
- **Quote, hold and run envelope.** `gatewayHoldMicros` (estimate + fee) is the
  hold on every gateway job, public and in-process. Quote = hold holds only for
  stills: `withGatewayImageQuotes` prices the body each still shape would send
  and quotes its hold. Video, audio and text quotes do not, and their run
  envelope (`reserveRunCredits`) carries no fee:
  - Video decides its route in the run's `route-motion` step, after the
    envelope is taken.
  - Audio routes are snapshotted at the trigger, but the body (the music
    prompt, the dialogue lines) is written in the run, and `gatewayRunRoute`
    can still send it direct.
  - Text resolves its route per call (`withTextGateway`), and its envelope
    share is the flat `estimateLLMCost` stand-in, not a card price.
  - In all three the pre-flight estimate is the fal or static rate table, not
    the card, so it never equals the hold anyway. A charge above what is left
    of a borrowed envelope grows it from the free balance; only when the
    balance cannot cover it do the lines fill in `inFillOrder` (provider cost
    first, so the fee is what goes unfunded, reported as a skipped deduction).
    At fee 0 nothing differs.
- **Shown as its own line** wherever a charge is shown: the job document's
  `platform_fee` line, the Models page ("Includes platform fee $x" under
  "Charged"), Settings → Transactions (per debit, from its charge lines) and
  Settings → Usage. At 0 no line is written and nothing shows.
- A remote job is charged by the hosted side at the hosted fee.
- The 7% top-up fee (`PLATFORM_FEE_PERCENT`) is separate: it applies to the
  money that funds the wallet.
- Tests: `platform-fee.test.ts` (including "every wrangler block sets a fee the
  worker accepts"); `in-process.test.ts` ("at fee %s bps the hold, the quote
  and the debit are the estimate plus the fee", at 0 and 250);
  `submit-job.test.ts` ("holds a replayed key at the fee its job was submitted
  at, not the current one");
  `text.test.ts` ("adds the platform fee as its own line on the hold and the
  charge").

## Usage view

Settings → Usage (`/settings/usage?days=7|30|90`, default 30) shows an
organization's gateway spend by model and by UTC day, with call counts and any
platform fee. The range is whole UTC days, today included
(`gatewayUsageSince`), read through `idx_charge_lines_organization_created`.

- `scopedDb.billing.getGatewaySpend(since)` (`src/billing/server/db/billing.ts`)
  groups the charge lines this organization paid by day and model: a text
  line's `sku`, else its job's `model_key`. `getGatewayUsageFn`
  (`src/billing/billing.fn.ts`) totals it; `src/billing/ui/gateway-usage.tsx`
  shows it.
- The lines are what the Transactions debits are made of, so the totals agree
  (`gateway-spend.test.ts`). Direct-path spend (own keys, unholdable models)
  writes no lines and is not in the view; it stays on Transactions.
- A one-key install's remote spend is charged to the hosted organization and
  shows there, not here.

## Text

Every LLM call the product makes on a platform key is charged in one place: a
meter on the key, read by the adapter wrapper. On a text card the price is the
gateway's (the card plus the fee); with no card it is `llmCostFromUsage`. No
call site bills an LLM call.

- **One seam.** `withTextGateway` wraps `scopedDb.apiKeys`, so every platform
  key comes back with a `meter` whose `card` is set when the model has a text
  card in the snapshot that prices `input_tokens` and `output_tokens`.
  `resolveNativeGrokModel` and `resolveNativeGeminiModel` still pick the
  provider, so the card is the provider's own (`openrouter/<id>`,
  `grok/<xAI id>`, `gemini/<Gemini id>`), read in the step that spends it, like
  the key. A card for a provider whose platform key this server lacks is never
  used.
- **Uncharged reasons, in the type.** `LlmKeyInfo.meter` is required. An
  organization's key carries `{ uncharged: 'own key' }`; a platform key a
  `TextMeter` or `{ uncharged: 'no organization' }`; a hosted key
  `{ uncharged: 'hosted gateway' }` (the hosted side holds and charges). So a
  platform key cannot run free by being marked `own key`. Only
  `getPlatformLlmKey` mints a `no organization` key, and
  `unmetered-llm-keys.test.ts` pins the files that may call it and fails on any
  other file that writes a reason literal or copies a meter. `createAdapter` and
  llm-client take the key as a required argument; `WorkflowScopedDb.apiKeys`
  has no LLM resolver, so a run reaches its key only through
  `credentials.resolveLlmKey`.
- **Direct with a reason** (priced as `llmCostFromUsage`, the reason on the
  transaction): `no card` (no snapshot row, a card that cannot price tokens,
  or OpenRouter through the platform fal key); `service tier priority is not on
  the card` (every llm-client OpenRouter call: script enhancement, the scene
  split, element and talent vision, the studio prompt draft, `ai.fn`,
  describe-upload, watch-clip; TanStack/schemas#768). The durable helpers, the
  assistant, the public endpoint and native xAI and Google calls are priced on
  the card.
- **The adapter.** `createAdapter` returns `openstoryText(adapter, meter,
  model)`: a proxy whose `chatStream`, `structuredOutput` and
  `structuredOutputStream` delegate and then charge once. It fails closed: any
  other method that could call the provider (`compact`, or one added upstream)
  throws. Tools, structured output, web search, vision, reasoning and durable
  streams are the inner adapter's, untouched. Each provider request is one
  charged call. A key resolved for one model is refused for another, so a call
  is never priced on another card.
- **In a run there is no per-call hold.** `base-workflow` resolves keys through
  `forWorkflowRun`, which carries the payload's `reservationId`; each card call
  settles its lines against it (`settleReservation` captures without closing),
  a direct call captures its cost. A run with no reservation holds at charge
  time and closes it in the same call (card), or `tryDeductCredits` (direct).
- **A request with no run** (a server fn, the assistant, the public endpoint)
  holds before the first byte, on the card route only, on `input_tokens` (the
  UTF-8 bytes of system prompts, messages, tool names and descriptions and the
  output schema; each media part counted at 4,096) and `output_tokens` (the
  request's own output budget). A request with no budget is refused before the
  hold. Bounds set where there were none: element vision 2,048; talent vision
  4,096; studio prompt draft 2,048; `recommendStyles` 2,048; describe-upload
  2,048; watch-clip 4,096; script enhancement `min(32,000, model max)`;
  assistant 8,192 per model call.
- **Charge at the end** on the usage the stream reported, through
  `normalizeUsage`, so cached, cache-write and reasoning tokens use their own
  levers and OpenRouter's server-side web searches the `web_searches` lever.
  The card route never uses the provider's `cost`.
- **Cut off** (the caller disconnects or aborts, or the provider fails after
  content): with no usage, the prompt and what streamed are estimated at UTF-8
  bytes / 3, rounded up, capped at what the output bound would have held. That
  errs slightly high on purpose: an under-estimate could be had by aborting
  every stream. A caller that disconnects before the first text still pays the
  prompt. Only a provider failure before any text is free. The direct route has
  no rate for an OpenRouter model without the provider's `cost`, so such a
  cut-off is reported as a missing cost, uncharged.
- **Unfunded script enhancement (#1567).** Its meter is `whenShort: 'run
  free'`: a request the balance cannot hold runs free, and on the direct route
  is charged what `tryDeductCredits` can take. Never refused, never negative.
  It is the only `allowUnfunded` caller.
- **Google region re-run.** A metered key re-runs through its meter's resolver,
  so the re-run is charged on its own route; a `no organization` key re-runs
  uncharged on the platform key; an organization's own Google key is refused,
  never re-run on a platform key.
- **Idempotency.** Each call is charged under `text:<id>`. A single-call site
  that may repeat for the same input passes its own key through `forCall`:
  - `likeness:<url>`: the check writes its verdict to the ledger, so a later
    check of the same URL never calls the provider. Only a failure between the
    charge and the verdict write repeats a call, which is not charged again.
  - `draft-vision:<url>`: each upload has its own URL, so a repeat is a client
    retry of the same upload. It calls the provider again unbilled, because no
    answer is stored to replay. Kept on purpose.
    The gateway submit's likeness check spends the platform key
    (`withPlatformLlmKey`) and is metered once per checked URL.
- **Descriptions.** Every metered call names its purpose (`forCall`'s
  `describe`, required): `Script enhancement`, `Prompt shortening (m)`, `Scene
  duration estimate (m)`, `Style recommendation (m)`, `Upload description
  (m)`, `Talent vision (m)`, `Element vision (m)`, `Studio prompt draft (m)`,
  `Assistant (m)`, `Watched a clip (m)`, `LLM analysis (m)`; the public
  endpoint writes `Gateway chat (m)`.
- **Behaviour.** An LLM call is charged when it happens, so a run that fails
  later still pays for its calls, and a retried step that calls again is
  charged again.
- **D1 per call.** A hold is 3 round trips, a settle 4 (one write batch), a
  release 1, plus the snapshot read: 5 in a run on a card, about 9 for a
  request on a card, 1 to 3 direct.
- **No job row.** A text call has nothing to poll, store or read back. Its
  record is the `credit_usage` debit and its lines (`sku` set, no job).

### The chat endpoint

`POST /api/v1/gateway/chat/{model}` (`src/gateway/server/chat.ts`) runs one
OpenStory analysis model on the same meter and streams AG-UI events. The body
is text turns, an optional system prompt, a required `maxTokens` and an
optional `outputSchema` (a JSON Schema object of at most 16 KB with `type:
"object"` at the root, checked before any hold, `gatewayChatBodySchema`); a structured
run ends with `structured-output.complete` and is charged once. Tools and media
are refused. It spends platform keys only (`resolvePlatformLlmKey`), so a model
whose card cannot price it is refused, never run direct.

## Uploads

`POST /api/v1/gateway/uploads` (`src/gateway/server/uploads.ts`): the body is
the file, `Content-Type` an image, video or audio type, `Content-Length` and
`Idempotency-Key` required.

- **Refused before a byte is read:** a blocked organization
  (`requireGenerationAllowed`), then `GATEWAY_UPLOAD_RATE_LIMITER` (120 a
  minute per organization, `429 RATE_LIMITED`). A new file is also refused when
  the organization cannot pay for its check (`402`) or keeps 500 live uploads or
  2 GB. A replay skips those two: it spends nothing. The cap is read off one
  list page, so concurrent uploads can overshoot by at most one rate window.
- **Size per kind:** 20 MB an image, 100 MB a clip, 25 MB audio, on
  `Content-Length` and again on the stream; a longer body is cut off, its
  partial file deleted, `400`.
- **A fresh id, written once:** `gateway-uploads/<organization>/<ULID>.<ext>`,
  create-only (R2 `if-none-match: *`), so nothing can replace the bytes the
  check classified.
- **Checked before it is answered:** `requireCheckedUploadRights` on that exact
  URL, charged on the platform key's meter (`likeness:<url>`, `whenShort:
  'refuse'`). A refusal deletes the file. A pass answers `201 { url }`.
- **The key maps to the id:** a create-only pointer at
  `gateway-uploads/<organization>/keys/<sha256 of the key>`. A replay answers
  that URL; a concurrent upload that loses the pointer race deletes its own
  file and answers the winner's. The install sends `sha256(<call key>:<r2
  key>)`.
- **Only the owner's:** a submit naming another organization's
  `gateway-uploads/` URL is `400` before the check (`gatewayFileOwner`).
- **Uploads expire after a day** (`GATEWAY_UPLOAD_TTL_MS`), with no operator
  step: `requireStorageRoom` deletes expired files and pointers before
  counting; a submit naming an expired or missing upload is `400 Upload
  expired; send it again` (final for that run; its next run uploads again); a
  replay whose file expired starts the key over. The R2 lifecycle rule is only
  the bulk clean-up: `wrangler r2 bucket lifecycle add <bucket>
  gateway-uploads-1d gateway-uploads/ --expire-days 1` (`bun setup --prod`
  prints it; not in `wrangler.jsonc`).

### Hosted outputs are not uploads

The hosted classifier calls any photoreal face human, generated character
sheets included, and cannot check audio. So a one-key install sends a file the
hosted gateway made back by its hosted URL, never as an upload.

- **Install.** When the HTTP transport copies a hosted job's outputs
  (`storeRemoteOutputs`), it records each hosted URL under
  `gateway-provenance/<sha256 of the local key>`. `withUploadedMedia` sends that
  URL for a file that has one.
- **Hosted.** `ownHostedOutputs` exempts a URL from the upload gate only when it
  is exactly how this server handed out an output (`toShareableUrl`) of a
  `succeeded` job of the calling organization, at
  `org/<organization>/gateway/<job id>/output-<n>`, and the object is still
  stored. The job row decides, never the URL's shape. Another organization's
  output is `400`; a look-alike or a deleted output is gated as any URL.
- **Why it is safe.** A hosted output derives only from inputs that passed the
  gate on the same endpoint. Outputs are written create-only
  (`storeGatewayOutput`, `upsert: false`), once, by that job.
- **Not covered.** A file the install derives (a dialogue section cut from a
  hosted take, a re-encoded still) has no record and is gated as an upload.
- **Expiry.** Hosted outputs are not expired today. If a lifecycle rule ever
  removes one, the stored-object check fails and the URL falls back to the
  upload gate, never trusted.

### Rate limits

`GATEWAY_RATE_LIMITER` is 300 submits a minute per organization (namespace
`2380`), uploads have their own 120 (`GATEWAY_UPLOAD_RATE_LIMITER`, namespace
`2438`), both declared in all three wrangler blocks; the per-key limiter (10 a
second) still applies. 300 is counted from the code paths, not measured: a
6-scene short peaks near 40 calls a minute, a 30-scene sequence near 180. A 429
is `{ error: { code: 'RATE_LIMITED' } }` with `Retry-After`.

## The snapshot

The gateway reads a model, its request schema and its rate card from
`gateway_models`, never from modelschemas on a request.

- **Product models are served from the snapshot; anything else is a live read
  and fails when modelschemas is down.** `getGatewayModel` answers from the
  stored row; on a miss it reads modelschemas through the catalog's bounded
  TTL cache, writes nothing, and refuses an answer under another id than the
  one asked for. Only the refresh writes rows, so a caller cannot grow the
  table by inventing ids. Live reads spend the refresh's modelschemas quota,
  so they are bounded per isolate: a refused id is remembered for ten
  minutes, and past 30 live reads a minute the answer is `429 RATE_LIMITED`.
- The snapshot holds exactly `productGatewayModels()` plus the text cards of
  `productTextModels()` (card only: a text body is the route adapter's and is
  never validated). `GET /api/v1/gateway/models` and the Models page lists read
  modelschemas' lists, so an outage hides them.
- `refreshGatewayModels` re-reads every product model under a 5 minute budget,
  each request cut off at 30 seconds. Only a row no longer in the product list,
  or that no longer parses, is dropped. A refusal, an answer under another id,
  an outage, a rate limit or the budget keeps the stored row and logs an error,
  so a bad modelschemas deploy cannot empty the snapshot.
- It runs on the daily cron (`FAL_PRICING_CRON`), before the fal pricing
  refresh and in its own `try`; no new cron expression. `bun
  scripts/refresh-fal-pricing.ts` runs both against local D1.
  `MODELSCHEMAS_API_KEY` is required in production (`scripts/push-secrets.ts`):
  a refresh is about two requests a model, past the anonymous 60 an hour, and
  a production refresh without it logs an error.
- The fal pricing refresh takes its cards from this snapshot; a used fal
  endpoint the snapshot does not hold keeps its stored
  `model_pricing.rate_card`, logged as a warning. So the card is stored twice
  until the price readers move to the snapshot (§ For the maintainer).
- Its own table because a `model_pricing` row is a fal unit price keyed by unit;
  a gateway model is keyed by provider and model id and carries a schema. A row
  is parsed on read, so a row an older deploy wrote is checked, not trusted.

## Coverage

`scripts/check-gateway-coverage.ts` prices two bodies for every product model
against its card: a typical request (the card's first example, plus a sample
for any request field the card needs) and the product's own body
(`src/gateway/server/coverage-bodies.ts`, through `buildImageRequest`,
`buildMotionRequest` and `buildGrokVideoRequest`). A usage lever with no
estimate is never filled. It exits 1 when a gap is not listed in this doc with
its upstream issue. `--recorded` reads the recorded fixture with no network;
`--drift` fails where live modelschemas differs from it.
`.github/workflows/gateway-coverage.yml` runs `--drift` weekly (Monday 03:17
UTC) and needs the `MODELSCHEMAS_API_KEY` repository secret.

On the recording of 2026-11-26: **43 of 76** product models hold and charge a
typical request, and **23 of 57** the body the product's builder sends. The 19
with no builder in the check (pinned in `coverage.test.ts`): the fal routes the
product's builders never pick (`fal/xai/grok-imagine-video/v1.5/text-to-video`,
`fal/xai/grok-imagine-video/v1.5/reference-to-video`,
`fal/fal-ai/kling-video/v3/pro/text-to-video`), audio and lip-sync
(`fal/fal-ai/ace-step-1.5`, `fal/fal-ai/ace-step/prompt-to-audio`,
`fal/fal-ai/sync-lipsync/v3`, `byteplus/seed-audio-1.0`,
`elevenlabs/music_v2_5`), Ark
(`byteplus/dola-seedream-5-0-pro-260628`,
`byteplus/dreamina-seedance-2-0-260128`,
`byteplus/dreamina-seedance-2-5-260628`,
`byteplus/dreamina-seedance-2-0-mini-260615`), Grok stills
(`grok/grok-imagine-image-2.0`, `grok/grok-imagine-image-quality`) and Gemini
(`gemini/gemini-nano-banana-2.1`, `gemini/gemini-3.1-flash-image`,
`gemini/gemini-3.1-flash-lite-image`, `gemini/gemini-3-pro-image`,
`gemini/gemini-omni-1.2-flash`).

`--json` prints `{ provider, id, holdable, reason, product, productReason }`
for each. `--recorded` reads `src/gateway/server/coverage.fixture.json`
(recorded 2026-11-26). `coverage.test.ts` fails when a gap is not listed here
with its upstream issue. Each stays refused until its card is fixed upstream;
no local estimate, sibling price or guess stands in.

### Still on the direct path

Everything below runs on today's direct provider path (own key or platform
key), priced as before. Each row is one product model or call.

| Model or call                                                   | Why                                                                    | Upstream                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------- |
| `fal/fal-ai/flux-2`                                             | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/fal-ai/flux-2/flash`                                       | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/fal-ai/flux-2/turbo`                                       | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/fal-ai/hidream-i1-full`                                    | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/fal-ai/hunyuan-image/v3/text-to-image`                     | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/fal-ai/hunyuan-image/v3/instruct/edit`                     | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/krea/v3/text-to-image`                                     | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/krea/v3/edit`                                              | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/fal-ai/krea-2/turbo`                                       | `megapixels` has no estimate                                           | TanStack/schemas#759       |
| `fal/google/nano-banana-2.1`                                    | token levers with no estimate                                          | TanStack/schemas#760       |
| `fal/google/nano-banana-2.1/edit`                               | token levers with no estimate                                          | TanStack/schemas#760       |
| `fal/google/nano-banana-2-lite`                                 | token levers with no estimate                                          | TanStack/schemas#760       |
| `fal/google/nano-banana-lite/edit`                              | token levers with no estimate                                          | TanStack/schemas#760       |
| `fal/openai/gpt-image-2.6/flare/text-to-image`                  | token levers with no estimate                                          | TanStack/schemas#760       |
| `fal/openai/gpt-image-2.6/flare/edit`                           | token levers with no estimate                                          | TanStack/schemas#760       |
| `byteplus/dola-seedream-5-0-pro-260628`                         | `input_images`, `generated_images` have no estimate; Ark portrait rule | TanStack/schemas#761       |
| `fal/fal-ai/ace-step/prompt-to-audio`                           | `seconds` has no estimate                                              | TanStack/schemas#762       |
| `fal/bytedance/seedance-2.0/enterprise/v2/image-to-video`       | no model row                                                           | TanStack/schemas#763       |
| `fal/bytedance/seedance-2.0/enterprise/v2/text-to-video`        | no model row                                                           | TanStack/schemas#763       |
| `fal/bytedance/seedance-2.0/enterprise/v2/reference-to-video`   | no model row                                                           | TanStack/schemas#763       |
| `fal/fal-ai/ace-step-1.5`                                       | no model row                                                           | TanStack/schemas#763       |
| `fal/fal-ai/qwen-image-2/pro/text-to-image`                     | no rate card                                                           | TanStack/schemas#763       |
| `fal/fal-ai/qwen-image-2/pro/edit`                              | no rate card                                                           | TanStack/schemas#763       |
| `gemini/gemini-nano-banana-2.1`                                 | request schema does not load (filed under `chat`)                      | TanStack/schemas#755       |
| `gemini/gemini-3.1-flash-image`                                 | request schema does not load                                           | TanStack/schemas#755       |
| `gemini/gemini-3.1-flash-lite-image`                            | request schema does not load                                           | TanStack/schemas#755       |
| `gemini/gemini-3-pro-image`                                     | request schema does not load                                           | TanStack/schemas#755       |
| `byteplus/dreamina-seedance-2-0-260128`                         | `input_video` has no estimate                                          | TanStack/schemas#764       |
| `byteplus/dreamina-seedance-2-5-260628`                         | `input_video` has no estimate                                          | TanStack/schemas#764       |
| `byteplus/dreamina-seedance-2-0-mini-260615`                    | `input_video` has no estimate                                          | TanStack/schemas#764       |
| `fal/fal-ai/sync-lipsync/v3`                                    | usage-only card (`minutes`)                                            | TanStack/schemas#765       |
| `gemini/gemini-omni-1.2-flash`                                  | usage-only card (tokens)                                               | TanStack/schemas#765       |
| `elevenlabs/music_v2_5`                                         | no card; the only ElevenLabs model on the gateway                      | TanStack/schemas#756       |
| `elevenlabs/eleven_ttv_v3`                                      | no card; `output_format` is a query parameter                          | TanStack/schemas#756       |
| `elevenlabs/eleven_v3`                                          | no card; dialogue endpoint not on the row; query parameter             | TanStack/schemas#756, #757 |
| `elevenlabs/eleven_multilingual_sts_v2`                         | no card; `v1/speech-to-speech` not on the row; multipart               | TanStack/schemas#756, #757 |
| Scribe (`scribe_v2`), isolation                                 | no row; multipart file                                                 | TanStack/schemas#757       |
| `fal/xai/grok-imagine-video/v1.5/image-to-video`                | product body: card types `image_url` boolean                           | TanStack/schemas#766       |
| `fal/fal-ai/kling-video/v3/pro/image-to-video`                  | product body: card `generate_audio` is an enum                         | TanStack/schemas#766       |
| `fal/minimax/h3-max/image-to-video`                             | product body: card `resolution` lower case, schema `768P`              | TanStack/schemas#766       |
| `fal/minimax/h3-max/text-to-video`                              | product body: same                                                     | TanStack/schemas#766       |
| `fal/minimax/h3-max/reference-to-video`                         | product body: same                                                     | TanStack/schemas#766       |
| `fal/fal-ai/nano-banana-pro`                                    | product body: `resolution: "2K"` not on the card                       | TanStack/schemas#769       |
| `fal/fal-ai/nano-banana-pro/edit`                               | product body: same                                                     | TanStack/schemas#769       |
| `fal/xai/grok-imagine-image/v2.0/text-to-image`                 | product body: `resolution: "2k"` not on the card                       | TanStack/schemas#769       |
| `fal/xai/grok-imagine-image/v2.0/edit`                          | product body: same                                                     | TanStack/schemas#769       |
| `fal/xai/grok-imagine-image/quality/text-to-image`              | product body: same                                                     | TanStack/schemas#769       |
| `fal/xai/grok-imagine-image/quality/edit`                       | product body: same                                                     | TanStack/schemas#769       |
| `fal/bytedance/seedream/v5/pro/text-to-image`                   | product body: `image_size: "landscape_16_9"` not on the card           | TanStack/schemas#769       |
| `fal/bytedance/seedream/v5/pro/edit`                            | product body: same                                                     | TanStack/schemas#769       |
| `fal/fal-ai/flux-2/flash/edit`                                  | product body: same                                                     | TanStack/schemas#769       |
| Grok native still edits (`v1/images/edits`)                     | no card for the edit endpoint                                          | TanStack/schemas#758       |
| Text calls on OpenRouter's priority tier (llm-client)           | no service-tier lever                                                  | TanStack/schemas#768       |
| OpenRouter through the platform fal key                         | fal's OpenRouter proxy has no card                                     | -                          |
| Ark Seedream, Ark video drafts and their finals                 | Ark portrait assets and task ids are the product's                     | -                          |
| Upscales, sheet portraits that edit, posters                    | not routed                                                             | -                          |
| Recast location's shots, shot previews, Replace element's shots | their children carry no routes                                         | -                          |

`grok/grok-imagine-video-1.5` runs on the gateway but its card has no
resolution lever, so a 720p clip is charged at the 480p rate
(TanStack/schemas#767; § For the maintainer).

### Price parity

`bun scripts/gateway-price-parity.ts` prices, for every product model the card
can hold, the product's own body (else the card's typical call) on the card,
against what the product charges today for the same call (fal:
`estimateFalCost` on `model_pricing` rows built from `LOCAL_FAL_PRICING_SEED`;
native: the static tables), fee excluded on both sides. On the recorded cards
(2026-11-26) 29 rows price, and **11 move more than 10%**: Seedance 2.5 i2v,
t2v and r2v (+49%), Seedance 2.0 mini r2v (-12%), fal Grok video t2v and r2v
(-43%, #767), Kling v3 Pro t2v (-33%), FLUX.2 Max (+70%), Phota and Phota edit
(+80%), FLUX.2 turbo edit (+116%). Every fal "today" figure is the local seed,
not production `model_pricing`, so each needs checking against production
before sign-off. FLUX.2 Max's text-to-image and edit cards disagree below one
megapixel; one of them is wrong upstream.

## Proven with real jobs

Local `bun dev`, platform keys, 2026-11-26. The lines summed to the debit on
every job, and each was charged once.

| Model                                      | Path                         | Hold      | Charge               |
| ------------------------------------------ | ---------------------------- | --------- | -------------------- |
| `grok-imagine-image`                       | public submit                | $0.02     | $0.02                |
| `grok-imagine-video-1.5-lite` (2 s)        | public submit                | $0.04     | $0.04                |
| `seed-audio-1.0`                           | public submit                | $0.30     | $0.0152              |
| `seedance-1-0-pro-fast-251015` (480p, 2 s) | public submit                | $0.01944  | $0.019845            |
| `seedance-1-0-pro-fast-251015` (480p, 2 s) | Models page                  | $0.01985  | $0.01985             |
| Grok Imagine 2.0 still                     | Studio, in-process           | $0.06     | $0.06                |
| Phota, and Phota edit with one reference   | Studio, in-process           | $0.09     | $0.09                |
| Grok Imagine Video 1.5 (6 s, 720p)         | `MotionWorkflow`, in-process | $0.48     | $0.48                |
| Seed Audio voice take (47.9 s)             | Generate voice, in-process   | $0.30     | $0.11975             |
| Sonnet 5.5, `maxTokens: 32`                | chat endpoint                | $0.000494 | $0.000116            |
| `grok-imagine-image`                       | one-key install over HTTP    | $0.02     | $0.02                |
| `seed-audio-1.0`                           | one-key install over HTTP    | $0.30     | $0.004906            |
| Sonnet 5.5, text and structured            | one-key install over HTTP    | -         | $0.000076, $0.000542 |

Text on the cards: every charge equalled OpenRouter's own `usage.cost`; a
funded run's card and direct calls drew on its reservation with no hold of
their own; an unfunded run held exactly its charge at charge time. Proven only
by tests: the run-reservation path for video, the platform fee at a non-zero
value, the usage view. Not proven: a full sequence on a fresh one-key clone
against a preview deployment.

## Self-hosted on one key (#2438)

An install with `OPENSTORY_API_KEY` set and no provider keys runs every
provider it has no key for on the hosted gateway; that key's organization pays
there, and the install holds and charges nothing (`onlyHostedGatewaySpends`).
A provider key in the install's own environment still wins for its provider.
Setup: `docs/developer-guide/self-hosted-one-key.md`.

It can run: stills and clips whose model the hosted card can price, Seed Audio
takes from stock or described voices, Models page runs, plain-text and
structured LLM calls.

It cannot run (the hosted side refuses, or the install refuses before sending):

- Every ElevenLabs call (music, voice design, dialogue, Scribe, isolation, mic
  takes through speech-to-speech): the public endpoint refuses ElevenLabs. They
  need `ELEVENLABS_API_KEY` on the install.
- Seed takes cloned from a voice clip: `references[]` audio is refused.
- A user upload showing any photoreal face, real or generated elsewhere:
  `ATTESTATION_REQUIRED`; no portrait attestation on the public endpoint.
- Any user-supplied audio, and audio cut or made on the install (mic takes,
  dialogue sections for lip-sync and Seedance audio references): the classifier
  cannot hear audio; only the hosted gateway's own outputs are exempt.
- Gemini images (TanStack/schemas#755) without a Google key; any model the
  hosted card cannot price.
- LLM calls with tools (script enhancement's web search, the assistant) and
  vision (upload descriptions, element and talent vision, Studio drafts with
  references, watch_clip): the chat endpoint takes text only. A vision call
  whose images are all the caller's own `gateway-uploads` URLs could be allowed
  later without new trust; not built.

## For the maintainer

**(a) Own keys on the gateway's drivers, and deleting the direct path: not
done.** Two sets of provider code remain: the gateway's drivers, and the direct
path for own keys and for every model the gateway cannot hold. The decision is
whether the in-process caller may pass an organization's own key to a driver,
with no charge for the provider cost, while the public endpoint keeps platform
keys only. Deleting the direct path needs first: every product model holdable
on its product body (the issues in § Still on the direct path, #755 to #769);
ElevenLabs cards (#756, #757) and a design for calls a JSON body cannot carry
(query parameters, multipart files); a service-tier lever for text (#768).

**(b) One price source: not done, for the same reason.** `model_pricing` as a
price table, the static native tables (`grok-native`, `seed-speech-pricing`,
`elevenlabs-pricing`, the `llmCostFromUsage` rates) and the fal billing
reconcile (#1069) still price the direct path. Once (a) lands they go:
`model_pricing` as a price table, `model_pricing.rate_card` (a copy of
`gateway_models`' card), the static tables and the reconcile. No migration in
this programme drops anything.

**(c) The platform fee value** (`GATEWAY_PLATFORM_FEE_BPS`, 0 today).

**(d) Needs sign-off:**

- Grok video 720p is charged at the 480p rate, about $0.36 under xAI's bill on
  a 6 s clip (TanStack/schemas#767).
- Every Seed take that answered is charged, including takes that fail the
  transcription check; on the direct path only the kept take was billed. The
  alternative is releasing a failed take's job instead of settling it.
- Studio holds per still on the `openstory` route, not per click.
- A transient provider 5xx fails an `openstory` still or a queued fal start;
  the direct path retried it. `openstory` fal stills write no
  `model_usage_observations`.
- An `openstory` still is written to R2 twice (`gateway/<id>/`, then the
  still's own key): the product's store callbacks take a URL.
- Plan envelopes price stills with no references and can over-reserve.
- The pre-#1581 upload backstop runs only on the gateway still path; moving it
  where both paths pass would refuse those references for own-key
  organizations.
- An organization's own hosted outputs skip the likeness gate as inputs.
- The rate limits (300 calls, 120 uploads a minute) and upload caps (20 / 100 /
  25 MB, 500 files or 2 GB, one day) are chosen, not measured.
- Unfunded script enhancement runs free when its hold (on a 32,000-token bound)
  fails, even when the real cost would have been covered.
- A direct-route cut-off on an OpenRouter model with no provider `cost` is
  charged $0.
- A retried step that calls an LLM again is charged again; the option is a
  per-attempt call counter in the key so the platform absorbs the repeat.
- The output bounds set on call sites that had none (§ Text).
- About 25 more card fetches per daily refresh.
- The 11 price-parity rows above.
- Measure a still quote's CPU on Workers (several shape checks per model).

**(e) `AssetGenerationWorkflow` stays.** It is the Models-page runner for the
own-key fal route and the remote route; deleting it needs (a).

**(f) The upscale failure thumbnail stays live.** `onFailure` in the upscale
workflow reads the shot's current still (`getAnchorImageUrl` on `liveRead`) for
the realtime event. A payload snapshot would repaint a still the user replaced
mid-run; it is a report read, not a render input.

## Not built

- An estimate endpoint and an app charges endpoint.
- Third-party apps with a spend cap, user-pays (OAuth grants with a monthly
  cap), app margins, declared SKUs and earnings: parked in #2387 and #2389. The
  `app_margin` and `app_charge` line kinds and the `app_id` column exist for
  them.
- Result webhooks.
- Extraction to its own Worker.
- Cash payouts (they need Stripe Connect and legal review).
- Reconciling the rate cards against provider bills: the charge is the card,
  and a wrong card is our loss or the caller's until that exists.
