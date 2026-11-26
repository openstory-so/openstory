/**
 * Can the gateway hold and charge every model the product uses? (#2432)
 *
 *   bun scripts/check-gateway-coverage.ts            # live modelschemas
 *   bun scripts/check-gateway-coverage.ts --record   # live, and rewrite the recorded fixture
 *   bun scripts/check-gateway-coverage.ts --recorded # the recorded fixture, no network
 *   bun scripts/check-gateway-coverage.ts --drift    # live, and exit 1 where it differs from the fixture
 *   add --json for [{ provider, id, holdable, reason, product }] on stdout instead of the table
 *
 * Two numbers: holdable on a typical request (the card's own example), and
 * holdable on the body the product's own builder sends, where one is known
 * (`product`: true, false, or null for no builder body).
 *
 * Two requests a model: set MODELSCHEMAS_API_KEY (anonymous is 60 an hour).
 * Exits 1 when a gap is not listed in docs/architecture/model-gateway.md.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { productGatewayModels } from '@/gateway/product-models';
import { productBodies } from '@/gateway/server/coverage-bodies';
import {
  coverageGap,
  modelCoverage,
  productGap,
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
const drifted = process.argv.includes('--drift')
  ? (() => {
      const fixture = new Map(
        z
          .array(recordedModelSchema)
          .parse(JSON.parse(readFileSync(FIXTURE, 'utf8')))
          .map((m) => [`${m.provider}/${m.id}`, JSON.stringify(m)])
      );
      return models
        .map((m) => `${m.provider}/${m.id}`)
        .filter((key, i) => fixture.get(key) !== JSON.stringify(models[i]));
    })()
  : [];
for (const key of drifted) {
  console.error(`Differs from coverage.fixture.json (re-record): ${key}`);
}

const bodies = productBodies();
const coverages = models.map((m) =>
  modelCoverage(m, bodies.get(`${m.provider}/${m.id}`))
);
const gaps = coverages.filter((c) => coverageGap(c) !== null);
const built = coverages.filter((c) => productGap(c) !== undefined);
const builtHeld = built.filter((c) => productGap(c) === null);
const summary = [
  `${coverages.length - gaps.length}/${coverages.length} hold and charge a typical request.`,
  `${builtHeld.length}/${built.length} hold and charge the product's own body (${coverages.length - built.length} have no builder body here).`,
];
if (process.argv.includes('--json')) {
  console.log(
    JSON.stringify(
      coverages.map((c) => {
        const reason = coverageGap(c);
        const product = productGap(c);
        return {
          provider: c.provider,
          id: c.id,
          holdable: !reason,
          reason,
          product: product === undefined ? null : product === null,
          productReason: product ?? null,
        };
      }),
      null,
      2
    )
  );
} else {
  const mark = (ok: boolean) => (ok ? 'yes' : 'no');
  console.log(
    '| Model | Found | Schema | Card | Hold | Charge | Product body |'
  );
  console.log('| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of coverages) {
    const product = productGap(c);
    console.log(
      `| \`${c.provider}/${c.id}\` | ${mark(c.found)} | ${mark(c.schema)} | ${mark(c.card)} | ${c.hold ?? 'yes'} | ${c.charge ?? 'yes'} | ${product === undefined ? 'no builder' : (product ?? 'yes')} |`
    );
  }
  console.log(`\n${summary.join('\n')}`);
}

if (process.argv.includes('--json')) console.error(summary.join('\n'));
const unlisted = unlistedGaps(coverages, readFileSync(DOC, 'utf8'));
for (const c of unlisted) {
  console.error(
    `Not listed in model-gateway.md: ${c.provider}/${c.id}: ${coverageGap(c) ?? productGap(c)}`
  );
}
process.exit(unlisted.length > 0 || drifted.length > 0 ? 1 : 0);
