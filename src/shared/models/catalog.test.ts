import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openStoryErrorSerializationAdapter } from '@/shared/errors';

/**
 * The catalog module holds a TTL response cache at module level, so each
 * test re-imports a fresh copy (vi.resetModules) with #env mocked — the
 * house doMock + dynamic-import pattern.
 *
 * MSW (src/test/setup.ts) wraps global fetch and forwards unhandled
 * requests to this stub as a single Request object, so helpers below
 * normalize both call shapes (`fetch(url, init)` and `fetch(request)`).
 */
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => urlOf(call[0]));
}

function fetchedHeaders(call: Parameters<typeof fetch>): Headers {
  const [input, init] = call;
  if (input instanceof Request) return input.headers;
  return new Headers(init?.headers);
}

let env: { MODELSCHEMAS_API_KEY?: string } = {};

async function importCatalog() {
  vi.resetModules();
  vi.doMock('#env', () => ({ getEnv: () => env }));
  return import('./catalog');
}

type ApiModelOverrides = {
  rawId?: string;
  activity?: string | null;
  displayName?: string;
  category?: string | null;
  deprecatedAt?: number | null;
};

function apiModel(overrides: ApiModelOverrides = {}) {
  const rawId = overrides.rawId ?? 'fal-ai/flux-1/dev';
  return {
    id: `fal-${rawId.replaceAll('/', '-')}`,
    provider: 'fal',
    rawId,
    activity: overrides.activity === undefined ? 'image' : overrides.activity,
    displayName: overrides.displayName ?? 'FLUX.1 [dev]',
    contextWindow: null,
    maxOutput: null,
    modalities: null,
    pricing: null,
    capabilities:
      overrides.category === null
        ? null
        : { category: overrides.category ?? 'text-to-image' },
    firstSeenAt: 1781210859,
    lastSeenAt: 1783721711,
    deprecatedAt: overrides.deprecatedAt ?? null,
  };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function modelsResponse(models: ReturnType<typeof apiModel>[]): Response {
  return jsonResponse({ count: models.length, models });
}

function schemaResponse(
  kind: 'input' | 'output',
  schema: object = { type: 'object', properties: {} }
): Response {
  return jsonResponse({
    provider: 'fal',
    activity: 'image',
    endpointId: 'fal-ai/flux-1/dev',
    kind,
    schema,
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  env = {};
});

describe('listCatalogModelFamilies', () => {
  it('maps API models to CatalogModel families', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([
        apiModel({
          rawId: 'fal-ai/kling-video/v3/pro',
          activity: 'video',
          displayName: 'Kling v3 Pro',
          category: 'image-to-video',
        }),
      ])
    );

    const result = await listCatalogModelFamilies({ activity: 'video' });

    expect(result.families).toEqual([
      {
        family: 'kling-video',
        title: 'Kling Video',
        activity: 'video',
        latestVersion: 'v3',
        releasedAt: 1781210859,
        representative: {
          endpointId: 'fal-ai/kling-video/v3/pro',
          displayName: 'Kling v3 Pro',
          activity: 'video',
          category: 'image-to-video',
          firstSeenAt: 1781210859,
          version: 'v3',
          variantLabel: 'pro',
        },
        variants: [
          {
            endpointId: 'fal-ai/kling-video/v3/pro',
            displayName: 'Kling v3 Pro',
            activity: 'video',
            category: 'image-to-video',
            firstSeenAt: 1781210859,
            version: 'v3',
            variantLabel: 'pro',
          },
        ],
      },
    ]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('groups same-family endpoints into one family', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([
        apiModel({
          rawId: 'fal-ai/flux-1/schnell',
          displayName: 'FLUX.1 [schnell]',
        }),
        apiModel({ rawId: 'fal-ai/flux-1/dev', displayName: 'FLUX.1 [dev]' }),
        apiModel({ rawId: 'fal-ai/recraft/v3', displayName: 'Recraft V3' }),
      ])
    );

    const { families } = await listCatalogModelFamilies();

    expect(families.map((f) => f.family)).toEqual(['flux', 'recraft']);
    expect(families[0]?.variants.map((v) => v.endpointId)).toEqual([
      'fal-ai/flux-1/dev',
      'fal-ai/flux-1/schnell',
    ]);
  });

  it('omits category when capabilities are null', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([apiModel({ category: null })])
    );

    const { families } = await listCatalogModelFamilies();
    expect(families[0]?.representative.category).toBeUndefined();
  });

  it('filters out chat, activity-less, and deprecated models', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([
        apiModel({ rawId: 'fal-ai/keep-me' }),
        apiModel({ rawId: 'fal-ai/chatty', activity: 'chat' }),
        apiModel({ rawId: 'fal-ai/no-activity', activity: null }),
        apiModel({ rawId: 'fal-ai/gone', deprecatedAt: 1783721711 }),
      ])
    );

    const { families } = await listCatalogModelFamilies();
    expect(
      families.flatMap((f) => f.variants.map((v) => v.endpointId))
    ).toEqual(['fal-ai/keep-me']);
  });

  it('paginates families locally with numeric-offset cursors', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    // Distinct unversioned ids → five single-variant families (title-sorted).
    const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo'];
    const all = names.map((name) =>
      apiModel({ rawId: `fal-ai/${name}`, displayName: name })
    );
    mockFetch.mockResolvedValue(modelsResponse(all));

    const page1 = await listCatalogModelFamilies({ limit: 2 });
    expect(page1.families.map((f) => f.family)).toEqual(['alpha', 'bravo']);
    expect(page1.nextCursor).toBe('2');

    const page2 = await listCatalogModelFamilies({ limit: 2, cursor: '2' });
    expect(page2.families.map((f) => f.family)).toEqual(['charlie', 'delta']);
    expect(page2.nextCursor).toBe('4');

    const page3 = await listCatalogModelFamilies({ limit: 2, cursor: '4' });
    expect(page3.families.map((f) => f.family)).toEqual(['echo']);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('treats an invalid cursor as the first page', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([apiModel()]));

    const { families } = await listCatalogModelFamilies({ cursor: 'garbage' });
    expect(families).toHaveLength(1);
  });

  it('passes provider, activity, and q upstream, unauthenticated by default', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([]));

    await listCatalogModelFamilies({ activity: 'image', q: 'flux' });

    expect(fetchedUrls()).toEqual([
      'https://modelschemas.com/v1/models?provider=fal&activity=image&q=flux',
    ]);
    const call = mockFetch.mock.calls[0];
    expect(call && fetchedHeaders(call).get('authorization')).toBeNull();
  });

  it('sends Authorization when MODELSCHEMAS_API_KEY is set', async () => {
    env = { MODELSCHEMAS_API_KEY: 'ms-test-key' };
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([]));

    await listCatalogModelFamilies();

    const call = mockFetch.mock.calls[0];
    expect(call && fetchedHeaders(call).get('authorization')).toBe(
      'Bearer ms-test-key'
    );
  });

  it('serves repeat requests from the TTL cache', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([apiModel()]));

    await listCatalogModelFamilies({ limit: 1 });
    const again = await listCatalogModelFamilies({ limit: 1 });

    expect(again.families).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws CatalogApiError with the upstream code and message', async () => {
    const { listCatalogModelFamilies, CatalogApiError } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'rate_limited', message: 'Too many requests' } },
        429
      )
    );

    const promise = listCatalogModelFamilies();
    await expect(promise).rejects.toBeInstanceOf(CatalogApiError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 429,
      code: 'rate_limited',
      message: 'Too many requests',
    });
  });

  it('throws a status-based CatalogApiError on a non-JSON error body', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(new Response('gateway荒', { status: 502 }));

    await expect(listCatalogModelFamilies()).rejects.toMatchObject({
      statusCode: 502,
      code: 'CATALOG_API_ERROR',
      message: 'modelschemas request failed (502)',
    });
  });

  it('carries code/statusCode across the server-fn boundary', async () => {
    // CatalogApiError must stay an OpenStoryError: any plain Error is
    // flattened to message-only by TanStack Router's ShallowErrorPlugin, and
    // isNoSchemaError (model-detail-view.tsx) would silently never match.
    const { CatalogApiError } = await importCatalog();
    const restored: unknown =
      openStoryErrorSerializationAdapter.fromSerializable(
        openStoryErrorSerializationAdapter.toSerializable(
          new CatalogApiError('No schema', 404, 'unknown_schema')
        )
      );

    expect(restored).toMatchObject({
      name: 'CatalogApiError',
      message: 'No schema',
      statusCode: 404,
      code: 'unknown_schema',
    });
  });
});

describe('getModelDetail', () => {
  function mockDetailFetches({
    output = schemaResponse('output'),
    metadataModels = [
      apiModel(),
      apiModel({
        rawId: 'fal-ai/flux-1/dev/redux',
        displayName: 'FLUX.1 [dev] Redux',
      }),
    ],
  }: {
    output?: Response;
    metadataModels?: ReturnType<typeof apiModel>[];
  } = {}) {
    mockFetch.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.includes('kind=input')) {
        return Promise.resolve(
          schemaResponse('input', {
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
            'x-fal-order-properties': ['prompt'],
          })
        );
      }
      if (url.includes('kind=output')) return Promise.resolve(output);
      return Promise.resolve(modelsResponse(metadataModels));
    });
  }

  it('returns metadata + input and output schemas', async () => {
    const { getModelDetail } = await importCatalog();
    mockDetailFetches();

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');

    expect(detail.model).toEqual({
      endpointId: 'fal-ai/flux-1/dev',
      displayName: 'FLUX.1 [dev]',
      activity: 'image',
      category: 'text-to-image',
      firstSeenAt: 1781210859,
    });
    expect(detail.inputSchema).toMatchObject({
      required: ['prompt'],
      'x-fal-order-properties': ['prompt'],
    });
    expect(detail.outputSchema).toMatchObject({ type: 'object' });

    // Endpoint slashes stay literal in the schema path.
    expect(fetchedUrls()).toContain(
      'https://modelschemas.com/v1/schemas/fal/image/fal-ai/flux-1/dev?kind=input'
    );
  });

  it('returns null output schema when the endpoint has none', async () => {
    const { getModelDetail } = await importCatalog();
    mockDetailFetches({
      output: jsonResponse({ error: { code: 'unknown_schema' } }, 404),
    });

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');
    expect(detail.outputSchema).toBeNull();
  });

  it('throws a 404 CatalogApiError when the input schema is missing', async () => {
    const { getModelDetail, CatalogApiError } = await importCatalog();
    mockFetch.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.includes('/v1/schemas/')) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'unknown_schema', message: 'No schema' } },
            404
          )
        );
      }
      return Promise.resolve(modelsResponse([]));
    });

    const promise = getModelDetail('fal-ai/does-not-exist', 'image');
    await expect(promise).rejects.toBeInstanceOf(CatalogApiError);
    await expect(promise).rejects.toMatchObject({
      statusCode: 404,
      code: 'unknown_schema',
    });
  });

  it('falls back to the endpoint id when no exact catalog row matches', async () => {
    const { getModelDetail } = await importCatalog();
    // `q` is a substring match — only a longer sibling comes back.
    mockDetailFetches({
      metadataModels: [apiModel({ rawId: 'fal-ai/flux-1/dev/redux' })],
    });

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');
    expect(detail.model).toEqual({
      endpointId: 'fal-ai/flux-1/dev',
      displayName: 'fal-ai/flux-1/dev',
      activity: 'image',
    });
  });

  it('keeps a deprecated endpoint’s real display name on the detail page', async () => {
    const { getModelDetail } = await importCatalog();
    mockDetailFetches({
      metadataModels: [apiModel({ deprecatedAt: 1783721711 })],
    });

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');
    // Deprecated models are dropped from the browse grid (toCatalogModel),
    // but the detail page must not degrade their identity to the raw id.
    expect(detail.model.displayName).toBe('FLUX.1 [dev]');
  });
});

describe('upstream shape guards', () => {
  it('throws a clear CatalogApiError when /v1/models loses its envelope', async () => {
    const { listCatalogModelFamilies, CatalogApiError } = await importCatalog();
    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [] }));

    const promise = listCatalogModelFamilies({ activity: 'image' });
    await expect(promise).rejects.toBeInstanceOf(CatalogApiError);
    await expect(promise).rejects.toThrow(/unexpected \/v1\/models response/);
  });

  it('drops malformed model entries instead of crashing the grid', async () => {
    const { listCatalogModelFamilies } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      jsonResponse({
        count: 2,
        models: [{ rawId: 42, displayName: null }, apiModel()],
      })
    );

    const result = await listCatalogModelFamilies({ activity: 'image' });
    expect(result.families).toHaveLength(1);
  });

  it('throws a clear CatalogApiError when a schema body is not an object', async () => {
    const { getModelDetail, CatalogApiError } = await importCatalog();
    mockFetch.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.includes('/v1/schemas/')) {
        return Promise.resolve(
          jsonResponse({ provider: 'fal', schema: 'not-a-schema' })
        );
      }
      return Promise.resolve(modelsResponse([apiModel()]));
    });

    await expect(
      getModelDetail('fal-ai/flux-1/dev', 'image')
    ).rejects.toBeInstanceOf(CatalogApiError);
  });
});
