/**
 * Fake BytePlus Ark (#2243): the asset control plane and the Seedance /
 * Seedream data plane, in memory on :4012. Ark answers are not prompt-keyed
 * like fal's, so a stateful fake replaces record/replay. Shapes match the
 * wire types in @tanstack/ai-byteplus and src/models/server/byteplus-assets.ts.
 */
import { createServer, type Server } from 'node:http';
import { z } from 'zod';

export const ARK_MOCK_PORT = 4012;

// Durable e2e media (mirrored by scripts/mirror-e2e-fixture-media.ts).
const VIDEO_URL =
  'https://assets.openstory.so/e2e/03785137f225c782c6dbfe353e26af0f7b1d2bf8d3ce7a1de32d19f392576cda.mp4';
const IMAGE_URL =
  'https://assets.openstory.so/e2e/bc0ed6dd53cf4816ede6553b8c66a3024b049c54de0632c9566d197bdab77f81.png';

type Asset = {
  Id: string;
  Name: string;
  GroupId: string;
  URL: string;
  AssetType: string;
};

let server: Server | undefined;
const hits: Record<string, number> = {};

export async function startArkMock(): Promise<void> {
  if (server) return;
  let next = 0;
  const id = (prefix: string) => `${prefix}-${Date.now()}-${++next}`;
  const groups = new Map<string, { Id: string; Name: string }>();
  const assets = new Map<string, Asset>();
  const tasks = new Map<string, { model: string }>();

  const envelope = (Result: unknown) => ({
    ResponseMetadata: { RequestId: id('req') },
    Result,
  });

  const control = (action: string, body: Record<string, unknown>) => {
    const filter = (body.Filter ?? {}) as {
      Name?: string;
      GroupIds?: string[];
    };
    switch (action) {
      case 'ListAssetGroups': {
        const items = [...groups.values()].filter(
          (g) => !filter.Name || g.Name === filter.Name
        );
        return { Items: items, TotalCount: items.length };
      }
      case 'CreateAssetGroup': {
        const group = { Id: id('group'), Name: String(body.Name) };
        groups.set(group.Id, group);
        return { Id: group.Id };
      }
      case 'CreateAsset': {
        const asset = {
          Id: id('asset'),
          Name: String(body.Name),
          GroupId: String(body.GroupId),
          URL: String(body.URL),
          AssetType:
            typeof body.AssetType === 'string' ? body.AssetType : 'Image',
        };
        assets.set(asset.Id, asset);
        return { Id: asset.Id };
      }
      case 'GetAsset': {
        const asset = assets.get(String(body.Id));
        return asset ? { ...asset, Status: 'Active' } : undefined;
      }
      case 'ListAssets': {
        const items = [...assets.values()]
          .filter((a) => !filter.Name || a.Name === filter.Name)
          .filter(
            (a) => !filter.GroupIds || filter.GroupIds.includes(a.GroupId)
          )
          .map((a) => ({ ...a, Status: 'Active' }));
        return { Items: items, TotalCount: items.length };
      }
      case 'DeleteAsset':
        assets.delete(String(body.Id));
        return null;
      case 'DeleteAssetGroup':
        groups.delete(String(body.Id));
        return null;
      default:
        throw new Error(`ark mock: unknown action ${action}`);
    }
  };

  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://localhost:${ARK_MOCK_PORT}`);
      const key =
        url.searchParams.get('Action') ??
        `${req.method} ${url.pathname.replace(/cgt-.*/, ':id')}`;
      hits[key] = (hits[key] ?? 0) + 1;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        const body = raw
          ? z.record(z.string(), z.unknown()).parse(JSON.parse(raw))
          : {};
        const action = url.searchParams.get('Action');
        if (action) {
          const result = control(action, body);
          return send(
            200,
            result === null ? { ResponseMetadata: {} } : envelope(result)
          );
        }
        const path = url.pathname.replace(/^\/api\/v3/, '');
        if (req.method === 'POST' && path === '/contents/generations/tasks') {
          const task = id('cgt');
          tasks.set(task, { model: String(body.model) });
          return send(200, { id: task });
        }
        const taskId = /^\/contents\/generations\/tasks\/(.+)$/.exec(path)?.[1];
        if (req.method === 'GET' && taskId) {
          const task = tasks.get(taskId);
          if (!task)
            return send(404, { error: { code: 'NotFound', message: taskId } });
          return send(200, {
            id: taskId,
            model: task.model,
            status: 'succeeded',
            content: { video_url: VIDEO_URL },
            usage: { completion_tokens: 100_000, total_tokens: 100_000 },
          });
        }
        if (req.method === 'POST' && path === '/images/generations') {
          return send(200, {
            created: Math.floor(Date.now() / 1000),
            data: [{ url: IMAGE_URL, size: '2048x2048' }],
            usage: { generated_images: 1 },
          });
        }
        send(404, {
          error: { code: 'NotFound', message: `${req.method} ${url.pathname}` },
        });
      } catch (error) {
        send(500, { error: { code: 'MockError', message: String(error) } });
      }
    });
  });
  await new Promise<void>((resolve) => server?.listen(ARK_MOCK_PORT, resolve));
}

export async function stopArkMock(): Promise<void> {
  if (Object.keys(hits).length) console.log('[e2e] ark mock calls', hits);
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
}
