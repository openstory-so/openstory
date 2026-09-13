/**
 * Extract one fal endpoint's rate card from its llms.txt and verify it
 * (#1605) — the cron's per-endpoint path, run by hand. Writes nothing.
 *
 *   bun scripts/extract-rate-card.ts fal-ai/kling-video/v3/pro/image-to-video
 *
 * Needs OPENROUTER_KEY (or FAL_KEY) in .env.local for the extraction model;
 * Bun autoloads `.env.local`, `--env-file=` overrides.
 */
import { evaluateRateCard } from '@/billing/rate-card/evaluate';
import { microsToUsd } from '@/billing/money';
import {
  extractRateCard,
  RATE_CARD_EXTRACTION_MODEL,
} from '@/billing/server/rate-card-extract';
import { fetchRateCardSource } from '@/billing/server/rate-card-source';
import { getPlatformLlmKey } from '@/models/server/create-adapter';

const endpointId = process.argv[2];
if (!endpointId) {
  console.error('usage: bun scripts/extract-rate-card.ts <endpointId>');
  process.exit(1);
}
const llmKey = getPlatformLlmKey(RATE_CARD_EXTRACTION_MODEL);
if (!llmKey) {
  console.error('OPENROUTER_KEY / FAL_KEY not set (add one to .env.local)');
  process.exit(1);
}

const fetched = await fetchRateCardSource(endpointId);
if (fetched.status !== 'ok') {
  console.error(`source: ${fetched.status}`);
  process.exit(1);
}
const { source } = fetched;
console.log(`source ${source.url}\nhash   ${source.hash}\n`);
console.log(source.text, '\n');

console.log(
  `extracting with ${RATE_CARD_EXTRACTION_MODEL} via ${llmKey.via}…\n`
);
const result = await extractRateCard(source, { llmKey });
console.log(`cost   $${microsToUsd(result.costMicros).toFixed(4)}`);
if (result.status === 'rejected') {
  console.log(`REJECTED: ${result.reason}`);
} else {
  console.log(
    `status ${result.verified ? 'verified' : 'UNVERIFIED (no examples)'}`
  );
  console.log(JSON.stringify(result.card, null, 2));
}
for (const r of result.results ?? []) {
  console.log(
    `${r.ok ? 'ok  ' : 'FAIL'} ${r.example.usd} ${JSON.stringify(r.example.params)} — ${r.example.quote}${r.error ? ` (${r.error})` : ''}`
  );
}
if (result.status === 'ok') {
  try {
    console.log(`default request → $${evaluateRateCard(result.card, {}).usd}`);
  } catch (error) {
    console.log(`default request → ${String(error)}`);
  }
}
