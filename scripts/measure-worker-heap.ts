/**
 * Measure the Worker isolate's JS heap across a realistic session (#1893).
 *
 * Run a production build under `wrangler dev` with the inspector on, then:
 *
 *   CLOUDFLARE_ENV=production bun run build
 *   echo 'VITE_APP_URL=http://localhost:8799' >> dist/server/.dev.vars
 *   bunx wrangler dev -c dist/server/wrangler.json --persist-to <state> \
 *     --port 8799 --inspector-port 9230 --enable-containers=false
 *   bun scripts/measure-worker-heap.ts --cookie <file> --studio-cookie <file> \
 *     --scenes /sequences/<id>/scenes?shot=<shotId> --out heap.json
 *
 * Cookie files hold one `better-auth.session_token=…` pair. Restart the
 * worker before each run: "boot" must be a fresh isolate, and wrangler's
 * inspector proxy takes one client, which a killed run keeps holding.
 *
 * Each step records the peak heap seen while it ran (sampled every 50 ms),
 * then takes a heap snapshot — workerd has no `HeapProfiler.collectGarbage`,
 * and a snapshot runs a full GC first — and records what survived, by V8
 * node type, plus the largest single strings.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { z } from 'zod';

const { values: args } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:8799' },
    inspector: { type: 'string', default: 'ws://127.0.0.1:9230/ws' },
    cookie: { type: 'string' },
    'studio-cookie': { type: 'string' },
    scenes: { type: 'string' },
    out: { type: 'string', default: 'heap.json' },
  },
});
if (!args.cookie || !args['studio-cookie'] || !args.scenes) {
  throw new Error('--cookie, --studio-cookie and --scenes are required');
}
const base = args.base;
const scenesPath = args.scenes;
const readCookie = (file: string) => readFileSync(file, 'utf8').trim();
const cookie = readCookie(args.cookie);
const studioCookie = readCookie(args['studio-cookie']);

// --- CDP over the wrangler inspector proxy ---------------------------------
// The proxy rejects a connection with no Origin.
// Bun's WebSocket takes headers; the DOM type does not know it.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const ws = new WebSocket(args.inspector, {
  headers: { Origin: 'http://localhost' },
} as unknown as string[]);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
ws.addEventListener('close', (event) => {
  throw new Error(`inspector closed: ${event.code} ${event.reason}`);
});
let nextId = 1;
const pending = new Map<number, (result: unknown) => void>();
let snapshotChunks: string[] = [];
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.method === 'HeapProfiler.addHeapSnapshotChunk') {
    snapshotChunks.push(msg.params.chunk);
  } else if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)?.(msg.result);
    pending.delete(msg.id);
  }
});
function cdp(method: string, params = {}): Promise<unknown> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}

const MB = (bytes: number) => Math.round((bytes / 1e6) * 10) / 10;
const heapUsage = z.object({ usedSize: z.number() });
const usedHeap = async () =>
  heapUsage.parse(await cdp('Runtime.getHeapUsage')).usedSize;

// --- heap snapshot summary -------------------------------------------------
const heapSnapshot = z.object({
  snapshot: z.object({
    meta: z.object({
      node_fields: z.array(z.string()),
      node_types: z.array(z.unknown()),
    }),
  }),
  nodes: z.array(z.number()),
  strings: z.array(z.string()),
});
const top = (map: Map<string, number>, n: number) =>
  Object.fromEntries(
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([key, bytes]) => [key, MB(bytes)])
  );

async function snapshot() {
  snapshotChunks = [];
  await cdp('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  const snap = heapSnapshot.parse(JSON.parse(snapshotChunks.join('')));
  snapshotChunks = [];
  const fields = snap.snapshot.meta.node_fields;
  const typeNames = z.array(z.string()).parse(snap.snapshot.meta.node_types[0]);
  const typeAt = fields.indexOf('type');
  const nameAt = fields.indexOf('name');
  const sizeAt = fields.indexOf('self_size');
  const byType = new Map<string, number>();
  const strings: Array<[string, number]> = [];
  let total = 0;
  for (let i = 0; i < snap.nodes.length; i += fields.length) {
    const type = typeNames[snap.nodes[i + typeAt] ?? -1] ?? '?';
    const size = snap.nodes[i + sizeAt] ?? 0;
    total += size;
    byType.set(type, (byType.get(type) ?? 0) + size);
    if (type === 'string' && size > 200_000) {
      const text = snap.strings[snap.nodes[i + nameAt] ?? -1] ?? '';
      strings.push([text.slice(0, 80).replace(/\s+/g, ' '), size]);
    }
  }
  return {
    totalMB: MB(total),
    byType: top(byType, 10),
    largestStrings: strings
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([text, size]) => ({ MB: MB(size), text })),
  };
}

// --- steps -----------------------------------------------------------------
const steps: unknown[] = [];

async function measure(step: string, run: () => Promise<string | void>) {
  let peak = await usedHeap();
  const sampling = { on: true };
  const sampler = (async () => {
    while (sampling.on) {
      peak = Math.max(peak, await usedHeap());
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  const note = (await run()) ?? undefined;
  sampling.on = false;
  await sampler;
  peak = Math.max(peak, await usedHeap());
  const heap = await snapshot();
  const afterGcMB = MB(await usedHeap());
  steps.push({ step, note, peakMB: MB(peak), afterGcMB, heap });
  console.log({ step, note, peakMB: MB(peak), afterGcMB });
}

// Server-fn ids differ per build: read them from the resolver chunk.
const resolverFile = readdirSync('dist/server/assets').find((f) =>
  f.includes('server-fn-resolver')
);
const resolver = readFileSync(`dist/server/assets/${resolverFile}`, 'utf8');
function serverFnId(name: string) {
  const match = resolver.match(
    new RegExp(`"([0-9a-f]{64})":\\s*\\{\\s*functionName:\\s*["\`]${name}_`)
  );
  if (!match?.[1]) throw new Error(`no server fn ${name} in ${resolverFile}`);
  return match[1];
}

async function openPage(
  context: BrowserContext,
  path: string,
  {
    watchFn,
    act,
  }: { watchFn?: string; act?: (page: Page) => Promise<void> } = {}
) {
  const page = await context.newPage();
  let serverFns = 0;
  let watched = 0;
  const watchedId = watchFn && serverFnId(watchFn);
  page.on('request', (r) => {
    if (!r.url().includes('/_serverFn/')) return;
    serverFns++;
    if (watchedId && r.url().includes(watchedId)) watched++;
  });
  await page.goto(base + path, { waitUntil: 'networkidle', timeout: 180_000 });
  if (act) {
    await act(page);
    await page.waitForLoadState('networkidle', { timeout: 180_000 });
  }
  await page.close();
  return watchFn
    ? `${serverFns} server fns, ${watchFn} x${watched}`
    : `${serverFns} server fns`;
}

const browser = await chromium.launch();
async function contextWith(cookieHeader: string) {
  const [name = '', value = ''] = cookieHeader.split(/=(.*)/s);
  const context = await browser.newContext();
  await context.addCookies([{ name, value, domain: 'localhost', path: '/' }]);
  return context;
}

await measure('boot', async () => {});

await measure('first request (GET /)', async () => {
  const res = await fetch(`${base}/`);
  await res.arrayBuffer();
  return `status ${res.status}`;
});

await measure('scenes SSR', async () => {
  const res = await fetch(base + scenesPath, { headers: { cookie } });
  const html = await res.arrayBuffer();
  return `status ${res.status}, ${MB(html.byteLength)} MB html`;
});

const userContext = await contextWith(cookie);
await measure('scenes page + server-fn burst', async () => {
  return openPage(userContext, scenesPath);
});

await measure('3 scenes pages at once', async () => {
  const fns = await Promise.all(
    [1, 2, 3].map(() => openPage(userContext, scenesPath))
  );
  return fns.join(' + ');
});

const studioContext = await contextWith(studioCookie);
await measure('sequences list (getShotsForSequencesFn)', async () => {
  // The shots load only once the list leaves its default gallery view.
  return openPage(studioContext, '/sequences', {
    watchFn: 'getShotsForSequencesFn',
    act: async (page) => {
      await page.getByRole('combobox', { name: 'Sequence view' }).click();
      await page.getByRole('option', { name: 'Compare images' }).click();
    },
  });
});

await measure('voice list (loads the ElevenLabs SDK)', async () => {
  // Seroval encoding of `{ data: {} }`, as the client sends a GET server fn.
  const payload = JSON.stringify({
    t: {
      t: 10,
      i: 0,
      p: { k: ['data'], v: [{ t: 10, i: 1, p: { k: [], v: [] }, o: 0 }] },
      o: 0,
    },
    f: 127,
    m: [],
  });
  const url = `/_serverFn/${serverFnId('listElevenLabsVoicesFn')}?payload=${encodeURIComponent(payload)}`;
  const page = await userContext.newPage();
  await page.goto(`${base}/`);
  const status = await page.evaluate(
    async (href) =>
      (await fetch(href, { headers: { 'x-tsr-serverFn': 'true' } })).status,
    url
  );
  await page.close();
  return `status ${status}`;
});

await browser.close();
writeFileSync(args.out, JSON.stringify(steps, null, 2));
process.exit(0);
