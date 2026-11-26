/** Which stills go through the gateway: a Grok model routed `openstory` whose body the endpoint takes (#2434). */

import { describe, expect, it } from 'vitest';
import type { GatewayModel } from '@/gateway/server/catalog';
import { gatewayRouteKey, type GatewayRoutes } from '@/gateway/server/route';
import { estimateImageCost } from '@/billing/cost-estimation';
import { micros } from '@/billing/money';
import { priceGatewayJob } from '@/gateway/server/price';
import { gatewayHoldMicros } from '@/gateway/server/submit-job';
import { withGatewayImageQuotes } from './image-gateway-routes';
import { gatewayImageRequest } from './image-generation';

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

  it('leaves a direct-route quote on the fal map', () => {
    const direct = withGatewayImageQuotes(fal, {});
    expect(direct[FAL_ID]).toEqual(fal[FAL_ID]);
  });
});
