/**
 * Fake BytePlus asset control plane (#2243), in memory on :4012. Seedance and
 * Seedream replay through aimock; aimock has no asset actions (CopilotKit/aimock#600).
 * Shapes match src/models/server/byteplus-assets.ts.
 */
import { createServer, type Server } from 'node:http';
import { z } from 'zod';

export const BYTEPLUS_ASSETS_MOCK_PORT = 4012;

type Asset = {
  Id: string;
  Name: string;
  GroupId: string;
  URL: string;
  AssetType: string;
};

let server: Server | undefined;
const hits: Record<string, number> = {};

export async function startBytePlusAssetsMock(): Promise<void> {
  if (server) return;
  let next = 0;
  const id = (prefix: string) => `${prefix}-${Date.now()}-${++next}`;
  const groups = new Map<string, { Id: string; Name: string }>();
  const assets = new Map<string, Asset>();

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
      const url = new URL(
        req.url ?? '/',
        `http://localhost:${BYTEPLUS_ASSETS_MOCK_PORT}`
      );
      const action = url.searchParams.get('Action');
      const key = action ?? `${req.method} ${url.pathname}`;
      hits[key] = (hits[key] ?? 0) + 1;
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      try {
        const body = raw
          ? z.record(z.string(), z.unknown()).parse(JSON.parse(raw))
          : {};
        if (action) {
          const result = control(action, body);
          return send(
            200,
            result === null ? { ResponseMetadata: {} } : envelope(result)
          );
        }
        send(404, {
          error: { code: 'NotFound', message: `${req.method} ${url.pathname}` },
        });
      } catch (error) {
        console.error('[byteplus-assets-mock]', error);
        send(500, { error: { code: 'MockError', message: 'mock failed' } });
      }
    });
  });
  await new Promise<void>((resolve) =>
    server?.listen(BYTEPLUS_ASSETS_MOCK_PORT, resolve)
  );
}

export async function stopBytePlusAssetsMock(): Promise<void> {
  if (Object.keys(hits).length)
    console.log('[e2e] byteplus assets mock calls', hits);
  await new Promise<void>((resolve) =>
    server ? server.close(() => resolve()) : resolve()
  );
  server = undefined;
}
