/** The gateway catalog over a mocked modelschemas and a test D1: what is runnable, what is refused, what is stored. */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '@/platform/errors';
import { gatewayModels } from '@/platform/server/db/schema';
import { createTestDb } from '@/platform/server/db/test-d1';

const SOURCE = {
  url: 'https://docs.example.com/pricing',
  hash: 'a'.repeat(64),
  extractedAt: '2026-11-01T00:00:00.000Z',
};
const CARD = {
  inputs: { duration: { param: 'duration', bound: 'request', kind: 'number' } },
  tables: {},
  price: { '*': [{ var: 'duration' }, 0.08] },
  examples: [],
  source: SOURCE,
};
const SCHEMA = {
  type: 'object',
  properties: { model: { type: 'string' }, duration: { type: 'number' } },
};

const { CatalogApiError } =
  await vi.importActual<typeof import('@/models/catalog')>('@/models/catalog');

// modelschemas by path; a path not listed is a 404.
let pages: Record<string, unknown> = {};
const fetchCatalogJson = vi.fn(async (path: string, _ttlMs: number) => {
  if (!(path in pages)) {
    throw new CatalogApiError('Unknown model', 404, 'unknown_model');
  }
  return JSON.stringify(pages[path]);
});
vi.doMock('@/models/catalog', () => ({ CatalogApiError, fetchCatalogJson }));

const { db, close } = await createTestDb();
vi.doMock('#db-client', () => ({ getDb: () => db }));

let products: { provider: 'grok'; id: string }[] = [];
vi.doMock('@/gateway/product-models', () => ({
  productGatewayModels: () => products,
}));

const {
  fetchGatewayModel,
  getBrowsableGatewayModel,
  getGatewayModel,
  listGatewayModels,
  listProviderModels,
} = await import('./catalog');
const { refreshGatewayModels } = await import('./refresh-models');

function record(overrides: Record<string, unknown>) {
  return {
    rawId: 'grok-imagine-video',
    displayName: 'Grok Imagine Video',
    activity: 'video',
    schemaEndpointId: 'v1/videos/generations',
    pricing: CARD,
    ...overrides,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  pages = {};
  products = [];
  await db.delete(gatewayModels);
});

afterAll(() => close());

const VIDEO_PAGES = {
  '/v1/models/grok/grok-imagine-video': record({}),
  '/v1/schemas/grok/video/v1/videos/generations?kind=input': { schema: SCHEMA },
};

describe('the stored snapshot', () => {
  it('is written only by the refresh: a request neither asks modelschemas nor stores', async () => {
    pages = VIDEO_PAGES;
    await expect(
      getGatewayModel('grok', 'grok-imagine-video')
    ).rejects.toBeInstanceOf(NotFoundError);
    // The Models page reads it live and keeps nothing.
    await getBrowsableGatewayModel('grok', 'grok-imagine-video');
    await expect(
      getGatewayModel('grok', 'grok-invented-alias')
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(fetchCatalogJson).toHaveBeenCalledTimes(2);
    expect(await db.select().from(gatewayModels)).toEqual([]);
  });

  it('serves a stored model with modelschemas unreachable', async () => {
    pages = VIDEO_PAGES;
    products = [{ provider: 'grok', id: 'grok-imagine-video' }];
    await refreshGatewayModels();
    fetchCatalogJson.mockClear();
    fetchCatalogJson.mockRejectedValue(new TypeError('fetch failed'));

    expect(await getGatewayModel('grok', 'grok-imagine-video')).toMatchObject({
      id: 'grok-imagine-video',
      kind: 'video',
    });
    expect(await listGatewayModels()).toEqual([
      {
        provider: 'grok',
        id: 'grok-imagine-video',
        name: 'Grok Imagine Video',
        kind: 'video',
      },
    ]);
    expect(fetchCatalogJson).not.toHaveBeenCalled();
    fetchCatalogJson.mockReset();
  });

  it('holds product models only, under their own id, and keeps one modelschemas could not answer', async () => {
    pages = {
      ...VIDEO_PAGES,
      '/v1/models/grok/grok-imagine-image': record({
        rawId: 'grok-imagine-image',
        activity: 'image',
        schemaEndpointId: 'v1/images/generations',
      }),
      '/v1/schemas/grok/image/v1/images/generations?kind=input': {
        schema: SCHEMA,
      },
      // An alias: modelschemas answers under the model's own id.
      '/v1/models/grok/grok-video-alias': record({}),
    };
    products = [
      { provider: 'grok', id: 'grok-imagine-video' },
      { provider: 'grok', id: 'grok-imagine-image' },
      { provider: 'grok', id: 'grok-gone' },
      { provider: 'grok', id: 'grok-video-alias' },
    ];
    expect(await refreshGatewayModels()).toEqual({
      stored: 2,
      dropped: 2,
      failed: 0,
    });

    // No longer a product model: dropped on the next pass.
    products = [{ provider: 'grok', id: 'grok-imagine-image' }];
    fetchCatalogJson.mockRejectedValue(
      new CatalogApiError('rate limited', 429)
    );
    await expect(refreshGatewayModels()).rejects.toThrow(
      'no model could be read'
    );
    fetchCatalogJson.mockReset();
    const rows = await db.select().from(gatewayModels);
    expect(rows.map((row) => row.modelId)).toEqual(['grok-imagine-image']);
  });

  it('stops asking modelschemas when its time budget runs out', async () => {
    pages = VIDEO_PAGES;
    products = [{ provider: 'grok', id: 'grok-imagine-video' }];
    await expect(refreshGatewayModels(db, -1)).rejects.toThrow(
      'no model could be read'
    );
    expect(fetchCatalogJson).not.toHaveBeenCalled();
  });
});

describe('fetchGatewayModel', () => {
  it('returns the model with its endpoint, card and request schema', async () => {
    pages = {
      '/v1/models/grok/grok-imagine-video': record({}),
      '/v1/schemas/grok/video/v1/videos/generations?kind=input': {
        schema: SCHEMA,
      },
    };
    expect(await fetchGatewayModel('grok', 'grok-imagine-video')).toEqual({
      provider: 'grok',
      id: 'grok-imagine-video',
      name: 'Grok Imagine Video',
      kind: 'video',
      endpointId: 'v1/videos/generations',
      card: CARD,
      inputSchema: SCHEMA,
    });
  });

  it('reads a BytePlus record off its own activity and endpoint', async () => {
    pages = {
      '/v1/models/byteplus/seedance-2-0-pro': record({
        rawId: 'seedance-2-0-pro',
        displayName: 'Seedance 2.0 Pro',
        schemaEndpointId: 'contents/generations/tasks',
      }),
      '/v1/schemas/byteplus/video/contents/generations/tasks?kind=input': {
        schema: SCHEMA,
      },
    };
    expect(
      await fetchGatewayModel('byteplus', 'seedance-2-0-pro')
    ).toMatchObject({
      id: 'seedance-2-0-pro',
      kind: 'video',
      endpointId: 'contents/generations/tasks',
    });
  });

  it('keeps a fal id as a path in the schema request', async () => {
    pages = {
      '/v1/models/fal/fal-ai%2Fferry%2Fvideo': record({
        rawId: 'fal-ai/ferry/video',
        schemaEndpointId: 'fal-ai/ferry/video',
      }),
      '/v1/schemas/fal/video/fal-ai/ferry/video?kind=input': { schema: SCHEMA },
    };
    expect(await fetchGatewayModel('fal', 'fal-ai/ferry/video')).toMatchObject({
      id: 'fal-ai/ferry/video',
      endpointId: 'fal-ai/ferry/video',
    });
  });

  it('refuses a model with no rate card, before its schema is fetched', async () => {
    for (const pricing of [null, { prompt: '0.000003' }]) {
      pages = { '/v1/models/grok/grok-imagine-video': record({ pricing }) };
      const error = await fetchGatewayModel('grok', 'grok-imagine-video').catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({ message: 'This model has no price' });
    }
    expect(fetchCatalogJson).toHaveBeenCalledTimes(2);
  });

  it('refuses a model that makes no media or names no endpoint', async () => {
    const records = [
      record({ activity: 'chat' }),
      record({ activity: null }),
      record({ schemaEndpointId: null }),
    ];
    for (const model of records) {
      pages = { '/v1/models/grok/grok-imagine-video': model };
      const error = await fetchGatewayModel('grok', 'grok-imagine-video').catch(
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toMatchObject({
        message: 'This model has no request schema',
      });
    }
  });

  it('is a NotFoundError when modelschemas answers 404', async () => {
    await expect(
      fetchGatewayModel('grok', 'grok-imagine-nothing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes any other modelschemas failure on', async () => {
    fetchCatalogJson.mockRejectedValueOnce(
      new CatalogApiError('rate limited', 429)
    );
    await expect(
      fetchGatewayModel('grok', 'grok-imagine-video')
    ).rejects.toBeInstanceOf(CatalogApiError);
  });
});

describe('listProviderModels', () => {
  it('lists media models with a driver, under their id when they have no display name', async () => {
    pages = {
      '/v1/models?provider=byteplus': {
        models: [
          record({
            rawId: 'seedream-5',
            displayName: null,
            activity: 'image',
            schemaEndpointId: 'images/generations',
          }),
          // Text out, and no driver for the endpoint.
          record({
            rawId: 'seed-asr',
            activity: 'audio',
            schemaEndpointId: 'auc/bigmodel/recognize/flash',
          }),
          record({ rawId: 'hitem3d', activity: null, schemaEndpointId: null }),
          record({
            rawId: 'seed-unpriced',
            activity: 'image',
            schemaEndpointId: 'images/generations',
            pricing: null,
          }),
        ],
      },
    };
    expect(await listProviderModels('byteplus')).toEqual([
      {
        provider: 'byteplus',
        id: 'seedream-5',
        name: 'seedream-5',
        kind: 'image',
        unavailable: null,
      },
      {
        provider: 'byteplus',
        id: 'seed-unpriced',
        name: 'Grok Imagine Video',
        kind: 'image',
        unavailable: 'This model has no price',
      },
    ]);
  });
});
