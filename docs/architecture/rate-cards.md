# Rate cards (#1605)

A provider's advertised price as data, evaluated deterministically against
the request we are about to send. Pre-flight estimates only: billing stays
`unitsBilled × bill-verified unitPrice` and never reads a card.

## Why

Offering a model and estimating its cost are different systems. A catalog
bump can ship a fal endpoint id that fal's pricing API lists as a `units` ×
$1 stub with no history, and every estimate for it then gates on the $0.10
unknown floor until enough generations have been billed. fal already
publishes the price on every endpoint's `llms.txt` — but as prose in ten
shapes (per-second tiers, per-image multipliers, token allowances,
size × quality tables, token formulas with minimum charges, dated promos),
so a single "$X per image" number is the wrong target. The card is the
prose as a small program.

## Schema

`src/billing/rate-card/rate-card.schema.ts`. A card is JSONLogic over a
closed vocabulary (`var`, arithmetic, comparisons, `if`, `and`/`or`,
`ceil`/`floor`, `max`/`min`) plus `lookup` into named tables. It carries:

- `inputs` — levers, each bound to the endpoint's **real request parameter
  name** (`resolution`, `generate_audio`, `duration`, `image_size`, the
  length of `image_urls`) with defaults. Kinds: `number`, `enum`,
  `boolean`, `count`, `dimensions` (explicit `{width, height}` or a preset).
- `tables` — nested numeric lookups (dimensions by resolution × ratio, size
  × quality USD, minimum tokens).
- `price` — the expression yielding USD for one request.
- `examples` — the page's own worked examples (`params`, `usd`, `quote`).
- `source` — URL, sha256 of the priced text, `extractedAt`, `expiresAt` when
  the text names a promo end.

The evaluator (`evaluate.ts`) refuses rather than coerces: an unknown op, an
unbound input, a missing table key, a non-numeric operand, or a price that
is not a finite positive number throws `RateCardError`. A refusal is an
honest unknown; a made-up number is a wrong credit gate.

## Where cards come from

- **Hand cards** (`rate-card/cards/`) for the endpoints we use, each quoting
  the text it was read from. The nightly cron seeds them onto
  `model_pricing.rate_card`.
- **Extraction** (`server/rate-card-extract.ts`) in the nightly
  `refreshFalPricing`: for each used endpoint, fetch the llms.txt Pricing +
  Input Schema sections (and the size table the playground page embeds for
  token-priced models), skip when the text hash is unchanged and no promo
  end has passed, otherwise one LLM call writes the card as JSON text and
  zod parses it. Capped per night; a rejected text is remembered so a
  persistent rejecter cannot hold a slot.
- **BytePlus** publishes no fal page, so its cards ride
  `BYTEPLUS_RATE_CARD` in code, keyed by Ark model id, and are aliased onto
  the fal endpoint ids (with the unit price) when Ark is configured. They
  bind the fal-shaped levers the estimator builds, not Ark's `size`
  template. Their dimension tables are keyed by resolution alone: Ark sizes
  a resolution class to the same pixel area whatever the ratio (frame jobs
  send `adaptive_<resolution>` and let the still pick it), the token
  formula reads only w × h, and BytePlus publishes no per-ratio sizes — so
  a 9:16 or 1:1 shot prices at the 16:9 area instead of refusing.
- **Sizes outside a table.** GPT Image 2.5 prices a canonical size × quality
  table, and the app sends fal presets or tier pixels (1280×720, 1072×1072)
  that are not in it; the table is not linear in area, so a size cannot be
  priced from the token rate. The card quotes the canonical row of the
  request's size band (large rows by area, 1024 rows by orientation) — the
  page's nearest stated figure — and calibration corrects the band.

## Verification

The LLM will sometimes be wrong, so a card is a trust boundary:

- every bound param and every example key must be a param the Input Schema
  declares (the model writes its own examples, so an invented lever would
  verify itself);
- every worked example in the text must reproduce within 1%, or the card is
  rejected with a warn naming the example; a text with no examples stores
  the card `unverified`;
- the default request is bounded to [$0.0001, $50];
- an extraction that drops a lever the hand card binds is refused and the
  hand card kept;
- a card past its `expiresAt` reads as unverified until re-extracted.

`/admin/rate-cards` shows every card with its evaluator verdicts;
`bun scripts/extract-rate-card.ts <endpointId>` runs one extraction by hand
and writes nothing.

## Estimation precedence

`estimateFalCost(endpointId, { request, … }, pricing)`:

1. **Verified card** evaluated against `request` — the built fal body where
   the caller has one (`calculateMotionMetadata`, `estimateImageCost`), else
   the levers a pre-flight gate knows, spelled with the endpoint's param
   names (`{ duration, resolution }`). No request → the card is skipped, not
   priced at its defaults. A refusal warn-logs and falls through.
2. **Observed median** unit count, once `MIN_OBSERVED_SAMPLES` back it.
3. **fal historical** units per call.
4. **null** — the caller gates on the unknown floor. Never a fabricated
   default, never a sibling endpoint's price.

## Calibration and drift

fal's per-second figures are "roughly"; promos end; a page can be misread.
So the card is checked against the bill continuously:

- Every fal usage sample records the request's **price levers**
  (`model_usage_observations.request_params`), reduced by `pricingLevers`:
  numbers, booleans, enum tokens, list lengths, `{width, height}`; never a
  prompt or URL. The ledger copy of the usage never carries them.
- The hourly reconcile (`calibrateRateCards`) replays each endpoint's recent
  samples through its verified card and computes
  `ratio = (unitsBilled × bill-verified unitPrice) / card(levers)`. The
  median is stored as `model_pricing.rate_card_calibration` with its sample
  count (reset whenever a new card is stored), and a `rate_card_drift`
  PostHog event carries endpoint, sample count, refused count, median and
  p90; the median outside [0.75, 1.33] warn-logs.
- The estimator multiplies the card's USD by the median once
  `MIN_OBSERVED_SAMPLES` back it. "Advertised" becomes "calibrated" over
  time without replacing the card's shape. A median outside the band means
  the card is misreading the page (a lever bound wrong, an ended promo):
  the estimator then skips the card rather than scaling a misread, and the
  unit counts the same samples back take over until the cron re-extracts.
- Reference clips are a card-level lever: the body carries only URLs, so
  `videoInputLever` adds `input_video_duration` (the clips' total seconds)
  to the levers the estimator and the observation see — never to the
  request. A sample that carried clips but no seconds (studio does not know
  its clips' lengths) is counted as refused, not replayed at the no-video
  rate. Cards past their promo end are not calibrated either; the estimator
  no longer uses them. The per-endpoint sample cap is applied in SQL.

Rows whose unit price is not bill-verified are skipped — comparing the page
with itself would always read 1.0. Ark units are not fal observations, so
Ark cards get no drift report. Report + calibration only: no retroactive
ledger adjustments.

## Retired by this design

`FAL_TYPICAL_UNITS_PER_DEFAULT_CLIP` (H3 Max 8 units/5s), the `tokens`
estimation strategy and `TOKEN_RESOLUTION_DIMENSIONS` (Seedance), the
`ENDPOINT_STRATEGY` token overrides, `FAL_ADVERTISED_CALL_USD`, the scalar
llms.txt parser (`parseAdvertisedImageUsd` / `parseSizeTableUsd`), and the
single-number BytePlus entries — each is now a card that quotes its text.
