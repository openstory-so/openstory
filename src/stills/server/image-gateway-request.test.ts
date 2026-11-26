/** Which stills go through the gateway: a Grok model routed `openstory` whose body the endpoint takes (#2434). */

import * as tanstackAi from '@tanstack/ai';
import { describe, expect, it, vi } from 'vitest';
import { NonRetryableError } from 'cloudflare:workflows';
import { asStub } from '@/test/as-stub';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { GatewayModel } from '@/gateway/server/catalog';
import { gatewayRouteKey, type GatewayRoutes } from '@/gateway/server/route';
import { estimateImageCost } from '@/billing/cost-estimation';
import { micros } from '@/billing/money';
import { priceGatewayJob } from '@/gateway/server/price';
import { gatewayHoldMicros } from '@/gateway/server/submit-job';

const inProcessGateway = vi.fn(() => ({}));
vi.doMock('@/gateway/server/adapter/in-process', () => ({ inProcessGateway }));
vi.doMock('@/gateway/server/adapter', () => ({ openstoryImage: () => ({}) }));
vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  generateImage: async () => ({ images: [{ url: '/r2/gateway/a.jpg' }] }),
}));
const { gatewayImageRequest, generateImageWithProvider } =
  await import('./image-generation');
const { withGatewayImageQuotes } = await import('./image-gateway-routes');

// The shape of modelschemas' `v1/images/generations` schema and card for Grok Imagine 2.0.
const GROK: GatewayModel = {
  provider: 'grok',
  id: 'grok-imagine-image-2.0',
  name: 'Grok Imagine Image 2.0',
  kind: 'image',
  endpointId: 'v1/images/generations',
  inputSchema: {
    type: 'object',
    properties: {
      model: { type: ['string', 'null'] },
      prompt: { type: 'string' },
      n: { type: ['integer', 'null'] },
      aspect_ratio: { type: ['string', 'null'] },
      resolution: { type: ['string', 'null'] },
      quality: { type: ['string', 'null'] },
    },
  },
  card: {
    inputs: {
      n: { param: 'n', bound: 'request', kind: 'number', default: 1 },
      quality: {
        param: 'quality',
        bound: 'request',
        kind: 'enum',
        values: ['low', 'medium', 'auto'],
        default: 'auto',
      },
    },
    tables: { rate: { low: 0.04, medium: 0.06, auto: 0.04 } },
    price: {
      '*': [
        { var: 'n' },
        { lookup: { table: 'rate', keys: [{ var: 'quality' }] } },
      ],
    },
    examples: [],
    source: {
      url: 'https://api.x.ai/v1/image-generation-models',
      hash: 'a'.repeat(64),
      extractedAt: '2026-10-05T05:16:00.263Z',
    },
  },
};

const OPENSTORY: GatewayRoutes = {
  [gatewayRouteKey('grok', 'grok-imagine-image-2.0')]: {
    via: 'openstory',
    model: JSON.stringify(GROK),
  },
};

const still = {
  model: 'grok_imagine_image' as const,
  prompt: 'A woman reads a letter by the window',
  imageSize: 'landscape_16_9' as const,
  numImages: 1,
};

describe('gatewayImageRequest', () => {
  it("sends a Grok still with no references as xAI's own body", () => {
    const request = gatewayImageRequest(still, OPENSTORY);
    expect(request?.model).toEqual(GROK);
    expect(request?.body).toMatchObject({
      model: 'grok-imagine-image-2.0',
      n: 1,
      aspect_ratio: '16:9',
      quality: 'medium',
    });
  });

  it('keeps a still with references direct: the endpoint takes none', () => {
    expect(
      gatewayImageRequest(
        { ...still, referenceImageUrls: ['/r2/characters/a.png'] },
        OPENSTORY
      )
    ).toBeNull();
  });

  it('keeps a model routed direct at the trigger direct', () => {
    expect(
      gatewayImageRequest(still, {
        'grok/grok-imagine-image-2.0': {
          via: 'direct',
          reason: 'The organization has its own key',
        },
      })
    ).toBeNull();
  });

  it('keeps a run triggered before routes existed direct', () => {
    expect(gatewayImageRequest(still, undefined)).toBeNull();
  });

  it('keeps a non-Grok still direct', () => {
    expect(
      gatewayImageRequest({ ...still, model: 'krea_2_turbo' }, OPENSTORY)
    ).toBeNull();
  });
});

describe('withGatewayImageQuotes', () => {
  const FAL_ID = 'xai/grok-imagine-image/v2.0/text-to-image';
  const fal = { [FAL_ID]: { unitPrice: micros(40_000), unit: 'images' } };

  it('quotes an openstory Grok still at exactly the gateway hold', () => {
    const request = gatewayImageRequest(still, OPENSTORY);
    if (!request) throw new Error('expected an openstory request');
    const hold = gatewayHoldMicros(
      priceGatewayJob(request.model.card, request.body)
    );
    const quote = estimateImageCost('grok_imagine_image', '16:9', 1, {
      pricing: withGatewayImageQuotes(fal, OPENSTORY),
    });
    expect(hold).toBe(60_000);
    expect(quote).toBe(hold);
  });

  it('quotes a still with references at the direct edit price, as the run routes it', () => {
    const EDIT_ID = 'xai/grok-imagine-image/v2.0/edit';
    const quote = estimateImageCost('grok_imagine_image', '16:9', 1, {
      pricing: withGatewayImageQuotes(
        {
          ...fal,
          [EDIT_ID]: {
            unitPrice: micros(40_000),
            unit: 'images',
            typicalUnitsPerCall: 1,
          },
        },
        OPENSTORY
      ),
      edit: true,
    });
    expect(quote).toBe(40_000);
  });

  it('leaves a direct-route quote on the fal map', () => {
    const direct = withGatewayImageQuotes(fal, {});
    expect(direct[FAL_ID]).toEqual(fal[FAL_ID]);
  });
});

// modelschemas' fal Nano Banana 2 schema and card, cut to the fields the product sends.
const nanoSchema = (edit: boolean) => ({
  type: 'object',
  properties: {
    prompt: { type: 'string' },
    aspect_ratio: { type: 'string' },
    resolution: { type: 'string', enum: ['0.5K', '1K', '2K', '4K'] },
    safety_tolerance: { type: 'string' },
    num_images: { type: 'integer' },
    sync_mode: { type: 'boolean' },
    ...(edit && { image_urls: { type: 'array', items: { type: 'string' } } }),
  },
});
const nano = (id: string, edit: boolean): GatewayModel => ({
  provider: 'fal',
  id,
  name: 'Nano Banana 2',
  kind: 'image',
  endpointId: id,
  inputSchema: nanoSchema(edit),
  card: {
    inputs: {
      num_images: {
        param: 'num_images',
        bound: 'request',
        kind: 'number',
        default: 1,
      },
      resolution: {
        param: 'resolution',
        bound: 'request',
        kind: 'enum',
        values: ['0.5K', '1K', '2K', '4K'],
        default: '1K',
      },
    },
    tables: { multiplier: { '0.5K': 0.75, '1K': 1, '2K': 1.5, '4K': 2 } },
    price: {
      '*': [
        { var: 'num_images' },
        0.08,
        { lookup: { table: 'multiplier', keys: [{ var: 'resolution' }] } },
      ],
    },
    examples: [],
    source: GROK.card.source,
  },
});
const NANO = nano('fal-ai/nano-banana-2', false);
const NANO_EDIT = nano('fal-ai/nano-banana-2/edit', true);
const FAL_ROUTES: GatewayRoutes = {
  [gatewayRouteKey('fal', NANO.id)]: {
    via: 'openstory',
    model: JSON.stringify(NANO),
  },
  [gatewayRouteKey('fal', NANO_EDIT.id)]: {
    via: 'openstory',
    model: JSON.stringify(NANO_EDIT),
  },
};
const falStill = {
  model: 'nano_banana_2' as const,
  prompt: 'A woman reads a letter by the window',
  imageSize: 'landscape_16_9' as const,
  numImages: 1,
};
const withRefs = { ...falStill, referenceImageUrls: ['/r2/characters/a.png'] };

describe('a fal still', () => {
  it('runs on the gateway with no references', () => {
    const request = gatewayImageRequest(falStill, FAL_ROUTES);
    expect(request?.model.id).toBe(NANO.id);
    expect(request?.body).toMatchObject({ prompt: falStill.prompt });
  });

  it('runs on the gateway with references, through the edit endpoint', () => {
    const request = gatewayImageRequest(withRefs, FAL_ROUTES);
    expect(request?.model.id).toBe(NANO_EDIT.id);
    expect(request?.body).toMatchObject({
      image_urls: ['/r2/characters/a.png'],
    });
  });

  it('stays direct with references when the edit endpoint is unholdable', () => {
    const routes: GatewayRoutes = {
      ...FAL_ROUTES,
      [gatewayRouteKey('fal', NANO_EDIT.id)]: {
        via: 'direct',
        reason: 'text_input_tokens (text_input_tokens): required',
      },
    };
    expect(gatewayImageRequest(falStill, routes)?.model.id).toBe(NANO.id);
    expect(gatewayImageRequest(withRefs, routes)).toBeNull();
  });

  // The fal rows exist; their prices are not what an openstory shape quotes.
  const FAL_ROWS = {
    [NANO.id]: { unitPrice: micros(1), unit: 'images' },
    [NANO_EDIT.id]: { unitPrice: micros(1), unit: 'images' },
  };

  it('is quoted at exactly the hold of the body it sends, references and count included', () => {
    const pricing = withGatewayImageQuotes(FAL_ROWS, FAL_ROUTES);
    for (const params of [falStill, withRefs]) {
      for (const resolution of [undefined, '720p', '4k'] as const) {
        const request = gatewayImageRequest(
          { ...params, numImages: 2, ...(resolution && { resolution }) },
          FAL_ROUTES
        );
        if (!request) throw new Error('expected an openstory request');
        const quote = estimateImageCost('nano_banana_2', '16:9', 2, {
          pricing,
          resolution,
          edit: params === withRefs,
        });
        expect(quote).toBe(
          gatewayHoldMicros(priceGatewayJob(request.model.card, request.body))
        );
      }
    }
  });

  it('quotes a count the endpoint refuses at the fal price, as the run sends it direct', () => {
    const schema = nanoSchema(false);
    const one: GatewayModel = {
      ...NANO,
      inputSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          num_images: { type: 'integer', maximum: 1 },
        },
      },
    };
    const routes: GatewayRoutes = {
      ...FAL_ROUTES,
      [gatewayRouteKey('fal', NANO.id)]: {
        via: 'openstory',
        model: JSON.stringify(one),
      },
    };
    const pricing = withGatewayImageQuotes(FAL_ROWS, routes);
    expect(
      gatewayImageRequest({ ...falStill, numImages: 2 }, routes)
    ).toBeNull();
    const request = gatewayImageRequest(falStill, routes);
    if (!request) throw new Error('expected an openstory request');
    expect(estimateImageCost('nano_banana_2', '16:9', 1, { pricing })).toBe(
      gatewayHoldMicros(priceGatewayJob(request.model.card, request.body))
    );
    const direct = withGatewayImageQuotes(FAL_ROWS, {});
    expect(estimateImageCost('nano_banana_2', '16:9', 2, { pricing })).toBe(
      estimateImageCost('nano_banana_2', '16:9', 2, { pricing: direct })
    );
  });

  it('refuses a quote with no fal row on either route, never $0', () => {
    const pricing = withGatewayImageQuotes({}, FAL_ROUTES);
    expect(pricing[NANO.id]).toBeUndefined();
    expect(
      estimateImageCost('nano_banana_2', '16:9', 1, { pricing })
    ).toBeNull();
  });
});

describe('a pipeline still on the openstory route', () => {
  const call = (runReservationId: string | undefined) =>
    generateImageWithProvider(still, {
      gateway: {
        routes: OPENSTORY,
        runReservationId,
        scopedDb: asStub<WorkflowScopedDb>({ organizationId: 'org-1' }),
        runId: 'run-1',
        idempotencyKey: 'run-1:image',
      },
    });

  it("charges the run's own reservation instead of holding again", async () => {
    inProcessGateway.mockClear();
    const result = await call('res-run');
    expect(result.via).toBe('openstory');
    expect(inProcessGateway).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: { id: 'res-run' } })
    );
  });

  it('holds per job when the run has no reservation', async () => {
    inProcessGateway.mockClear();
    await call(undefined);
    expect(inProcessGateway).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: null })
    );
  });
});

describe('an upload reference with no likeness verdict', () => {
  it('is refused before the gateway sees it', async () => {
    inProcessGateway.mockClear();
    const error = await generateImageWithProvider(
      { ...withRefs, referenceImageUrls: ['/r2/talent/org-1/uploads/old.jpg'] },
      {
        gateway: {
          routes: FAL_ROUTES,
          runReservationId: undefined,
          scopedDb: asStub<WorkflowScopedDb>({
            organizationId: 'org-1',
            liveRead: {
              compliance: {
                attestations: { listForSubject: async () => [] },
              },
            },
          }),
          runId: 'run-1',
          idempotencyKey: 'run-1:image',
        },
      }
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(inProcessGateway).not.toHaveBeenCalled();
  });
});
