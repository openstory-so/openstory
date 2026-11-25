/**
 * Can the gateway hold and charge every model the product uses? (#2432)
 *
 *   bun scripts/check-gateway-coverage.ts            # live modelschemas
 *   bun scripts/check-gateway-coverage.ts --record   # live, and rewrite the recorded fixture
 *   bun scripts/check-gateway-coverage.ts --recorded # the recorded fixture, no network
 *
 * Two requests a model: set MODELSCHEMAS_API_KEY (anonymous is 60 an hour).
 * Exits 1 when a gap is not listed in docs/architecture/model-gateway.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { productGatewayModels } from '@/gateway/product-models';
import {
  coverageGap,
  modelCoverage,
  type RecordedModel,
  recordedModelSchema,
  unlistedGaps,
} from '@/gateway/server/coverage';
import { z } from 'zod';

const ROOT = resolve(import.meta.dirname, '..');
const FIXTURE = resolve(ROOT, 'src/gateway/server/coverage.fixture.json');
const DOC = resolve(ROOT, 'docs/architecture/model-gateway.md');

const headers: Record<string, string> = { Accept: 'application/json' };
if (process.env.MODELSCHEMAS_API_KEY) {
  headers.Authorization = `Bearer ${process.env.MODELSCHEMAS_API_KEY}`;
}

async function get(path: string): Promise<unknown> {
  const response = await fetch(`https://modelschemas.com${path}`, { headers });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

const liveRecord = recordedModelSchema.shape.record.unwrap();

async function fetchModel(
  provider: RecordedModel['provider'],
  id: string
): Promise<RecordedModel> {
  const body = await get(`/v1/models/${provider}/${encodeURIComponent(id)}`);
  if (body === null) return { provider, id, record: null, schema: false };
  const record = liveRecord.parse(body);
  const { activity, schemaEndpointId: endpoint } = record;
  if (activity === null || endpoint === null) {
    return { provider, id, record, schema: false };
  }
  const path = provider === 'fal' ? endpoint : encodeURI(endpoint);
  const schema =
    (await get(`/v1/schemas/${provider}/${activity}/${path}?kind=input`)) !==
    null;
  return { provider, id, record, schema };
}

const recorded = process.argv.includes('--recorded');
const models = recorded
  ? z
      .array(recordedModelSchema)
      .parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  : await Promise.all(
      productGatewayModels().map(({ provider, id }) => fetchModel(provider, id))
    );
if (process.argv.includes('--record')) {
  writeFileSync(FIXTURE, `${JSON.stringify(models, null, 2)}\n`);
}

const coverages = models.map(modelCoverage);
const mark = (ok: boolean) => (ok ? 'yes' : 'no');
console.log('| Model | Found | Schema | Card | Hold | Charge |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const c of coverages) {
  console.log(
    `| \`${c.provider}/${c.id}\` | ${mark(c.found)} | ${mark(c.schema)} | ${mark(c.card)} | ${c.hold ?? 'yes'} | ${c.charge ?? 'yes'} |`
  );
}
const gaps = coverages.filter((c) => coverageGap(c) !== null);
console.log(
  `\n${coverages.length - gaps.length}/${coverages.length} can be held and charged.`
);

const unlisted = unlistedGaps(coverages, readFileSync(DOC, 'utf8'));
for (const c of unlisted) {
  console.error(
    `Not listed in model-gateway.md: ${c.provider}/${c.id}: ${coverageGap(c)}`
  );
}
process.exit(unlisted.length > 0 ? 1 : 0);
