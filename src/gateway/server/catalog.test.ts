/** The gateway catalog over a mocked modelschemas: what is runnable, and what is refused. */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ValidationError } from '@/platform/errors';

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

const { getGatewayModel, listGatewayModels } = await import('./catalog');

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

beforeEach(() => {
  vi.clearAllMocks();
  pages = {};
});

describe('getGatewayModel', () => {
  it('returns the model with its endpoint, card and request schema', async () => {
    pages = {
      '/v1/models/grok/grok-imagine-video': record({}),
      '/v1/schemas/grok/video/v1/videos/generations?kind=input': {
        schema: SCHEMA,
      },
    };
    expect(await getGatewayModel('grok', 'grok-imagine-video')).toEqual({
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
    expect(await getGatewayModel('byteplus', 'seedance-2-0-pro')).toMatchObject(
      {
        id: 'seedance-2-0-pro',
        kind: 'video',
        endpointId: 'contents/generations/tasks',
      }
    );
  });

  it('keeps a fal id as a path in the schema request', async () => {
    pages = {
      '/v1/models/fal/fal-ai%2Fferry%2Fvideo': record({
        rawId: 'fal-ai/ferry/video',
        schemaEndpointId: 'fal-ai/ferry/video',
      }),
      '/v1/schemas/fal/video/fal-ai/ferry/video?kind=input': { schema: SCHEMA },
    };
    expect(await getGatewayModel('fal', 'fal-ai/ferry/video')).toMatchObject({
      id: 'fal-ai/ferry/video',
      endpointId: 'fal-ai/ferry/video',
    });
  });

  it('refuses a model with no rate card, before its schema is fetched', async () => {
    for (const pricing of [null, { prompt: '0.000003' }]) {
      pages = { '/v1/models/grok/grok-imagine-video': record({ pricing }) };
      const error = await getGatewayModel('grok', 'grok-imagine-video').catch(
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
      const error = await getGatewayModel('grok', 'grok-imagine-video').catch(
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
      getGatewayModel('grok', 'grok-imagine-nothing')
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes any other modelschemas failure on', async () => {
    fetchCatalogJson.mockRejectedValueOnce(
      new CatalogApiError('rate limited', 429)
    );
    await expect(
      getGatewayModel('grok', 'grok-imagine-video')
    ).rejects.toBeInstanceOf(CatalogApiError);
  });
});

describe('listGatewayModels', () => {
  it('lists priced media models and drops the rest', async () => {
    pages = {
      '/v1/models?provider=fal': {
        models: [
          record({ rawId: 'fal-ai/ferry/video', displayName: 'Ferry Video' }),
          record({ rawId: 'fal-ai/unpriced', pricing: null }),
        ],
      },
      '/v1/models?provider=byteplus': {
        models: [
          record({
            rawId: 'seedream-5',
            displayName: 'Seedream 5',
            activity: 'image',
            schemaEndpointId: 'images/generations',
          }),
          record({
            rawId: 'seed-audio-1.0',
            displayName: 'Seed Audio',
            activity: 'audio',
            schemaEndpointId: 'tts/create',
          }),
          // Text out, and no driver for the endpoint.
          record({
            rawId: 'seed-asr',
            activity: 'audio',
            schemaEndpointId: 'auc/bigmodel/recognize/flash',
          }),
          record({ rawId: 'hitem3d', activity: null, schemaEndpointId: null }),
        ],
      },
      '/v1/models?provider=gemini': {
        models: [
          record({ rawId: 'gemini-chat', activity: 'chat' }),
          record({ rawId: 'gemini-nothing', activity: null }),
          record({ rawId: 'gemini-no-endpoint', schemaEndpointId: null }),
        ],
      },
      '/v1/models?provider=grok': {
        models: [record({ activity: 'audio', displayName: 'Grok Voice' })],
      },
    };
    expect(await listGatewayModels()).toEqual([
      {
        provider: 'fal',
        id: 'fal-ai/ferry/video',
        name: 'Ferry Video',
        kind: 'video',
      },
      {
        provider: 'byteplus',
        id: 'seedream-5',
        name: 'Seedream 5',
        kind: 'image',
      },
      {
        provider: 'byteplus',
        id: 'seed-audio-1.0',
        name: 'Seed Audio',
        kind: 'audio',
      },
      {
        provider: 'grok',
        id: 'grok-imagine-video',
        name: 'Grok Voice',
        kind: 'audio',
      },
    ]);
  });
});
