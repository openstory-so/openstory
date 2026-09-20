# Fal.ai Integration

**Always check `/llms.txt` before updating models.** Machine-readable, authoritative param specs:

```
https://fal.ai/models/{model-path}/llms.txt
# e.g. https://fal.ai/models/fal-ai/kling-video/v2.5-turbo/pro/image-to-video/llms.txt
```

More reliable than HTML docs; essential for `src/models/models.ts`. **For new motion models, run `bun motion:codegen`** to auto-generate schemas — don't write inline.

Motion status checking: `checkMotionStatus(statusUrl)`, `getMotionResult(responseUrl)`, `cancelMotionGeneration(cancelUrl)` from `@/motion/server/motion-generation`, or `bun scripts/check-motion-status.ts <url>`.

**Pricing is DB-only (#1069).** `model_pricing` in D1 is the **only** pricing record — there is no baked-in seed. The daily cron (and `bun scripts/refresh-fal-pricing.ts` locally, needs `FAL_KEY`) fills it with unit prices for **every priced endpoint in fal's catalog** (~1,350; raw unit strings, batches of ≤50 — the pricing API's cap), plus fal's typical-units estimates for the endpoints we actually use and observed medians from our own generations. `bun dev` never fires `scheduled()`, so until the script runs locally the table is empty: estimates gate on the $0.10 floor and billing records $0 (reported via `reportMissingBillingCost`).

**The pricing API can lie — fal's bill is the ground truth.** fal's `/v1/models/pricing` reported Grok Imagine at "compute seconds" × $0.00017 while fal actually billed "units" × $0.01 (~59× under-charge; audit found 6 more mispriced endpoints, one 33% OVER-charging). Three corrective layers, all needing the ADMIN-scoped `FAL_BILLING_KEY` (`wrangler secret put` in prod; `.env.local` or `FAL_BILLING_KEY_DEV` locally — without it both crons error-log and prices run unverified): (1) the nightly refresh overlays billed rates from `/v1/models/usage` (30d); (2) `model_pricing.rateVerifiedAt` — once bill-verified, an advertised rate can never overwrite a row, only newer billed data; (3) the **hourly reconcile** (`src/billing/server/reconcile-fal-billing.ts`) audits every charge against per-request `/v1/models/billing-events` (joined by the fal `requestId` workflows store in transaction metadata), corrects rates within the hour, and reports drift (`billing_drift` PostHog event) — report-only, no retroactive ledger adjustments. `x-fal-billable-units` is set by each model's own code (denomination is author-defined), so billing stays `unitsBilled × verified unitPrice` and never interprets units client-side.

**Cron jobs need wiring in three places** (like Workflows): `wrangler.jsonc` `triggers.crons` in the **default** block, the same in **`[env.production]`** (non-inheritable), and the constant `scheduled()` string-matches on (e.g. `FAL_PRICING_CRON`). Drift is silent — an unmatched expression falls through to the 5-minute reconcile sweep, which _succeeds_, so the job just never runs. `src/billing/server/refresh-fal-pricing.test.ts` enforces it.
