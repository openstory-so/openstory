/** The video job's route (own key, gateway, direct) and the poll that follows the stamp. */

import { describe, expect, it, vi } from 'vitest';
import type { GatewayModel } from '@/gateway/server/catalog';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
import type { WorkflowStep } from 'cloudflare:workers';
import { asStub } from '@/test/as-stub';
import {
  mockFalVideo,
  mockGenerateVideo,
  mockGetVideoJobStatus,
} from '@/motion/server/__mocks__/fal-client.mock';

const GROK: GatewayModel = {
  provider: 'grok',
  id: 'grok-imagine-video-1.5',
  name: 'Grok Imagine Video',
  kind: 'video',
  endpointId: 'v1/videos/generations',
  inputSchema: {},
  card: {
    inputs: {
      duration: { param: 'duration', bound: 'request', kind: 'number' },
    },
    tables: {},
    price: { '*': [{ var: 'duration' }, 0.08] },
    examples: [],
    source: {
      url: 'https://docs.example.com/pricing',
      hash: 'a'.repeat(64),
      extractedAt: '2026-11-01T00:00:00.000Z',
    },
  },
};

const actualCatalog = await vi.importActual<
  typeof import('@/gateway/server/catalog')
>('@/gateway/server/catalog');
vi.doMock('@/gateway/server/catalog', () => ({
  ...actualCatalog,
  getSnapshotGatewayModel: async () => GROK,
}));
const poller = vi.fn();
type TransportParams = Parameters<
  typeof import('@/gateway/server/adapter/in-process').inProcessGateway
>[0];
const transport = vi.fn<(params: TransportParams) => void>();
const releaseInProcessJob = vi.fn(async () => {});
vi.doMock('@/gateway/server/adapter/in-process', () => ({
  gatewayRunOf: (handle: string) =>
    handle.startsWith('done:') ? null : { jobId: 'gw-1', provider: 'byteplus' },
  releaseInProcessJob,
  inProcessGateway: (params: TransportParams) => {
    transport(params);
    return { submit: vi.fn(), status: vi.fn() };
  },
  inProcessPoller: () => {
    poller();
    return { status: vi.fn() };
  },
}));
const actualExternalUrl = await vi.importActual<
  typeof import('@/platform/server/storage/external-url')
>('@/platform/server/storage/external-url');
vi.doMock('@/platform/server/storage/external-url', () => ({
  ...actualExternalUrl,
  // Each call is a new upload, as fal storage gives without a CDN.
  fetchableFalBody: async (body: unknown) =>
    JSON.parse(
      JSON.stringify(body).replaceAll('/r2/', 'https://fal.media/upload-')
    ),
}));
const remoteJobCharge = vi.fn();
const actualHttp = await vi.importActual<
  typeof import('@/gateway/server/adapter/http')
>('@/gateway/server/adapter/http');
vi.doMock('@/gateway/server/adapter/http', () => ({
  ...actualHttp,
  remoteJobCharge,
}));
vi.doMock('#env', () => ({
  getEnv: () => ({ FAL_KEY: 'platform-fal', XAI_API_KEY: 'platform-xai' }),
}));

const {
  falApiKey,
  readGatewayCharge,
  pollVideoJob,
  releaseTimedOutVideoJob,
  routeVideoJob,
  sendVideoJob,
  videoGatewayStore,
  videoJobProviderVia,
} = await import('./video-job');

/** A provider call that sends `{ duration: 5 }`; counts the calls that reached the provider. */
function provider() {
  const sent = vi.fn();
  const send = async (
    fetch: typeof globalThis.fetch = async () => {
      sent();
      return new Response('{}');
    }
  ) => {
    await fetch('https://provider.example/v1/videos', {
      method: 'POST',
      body: JSON.stringify({ duration: 5 }),
    });
    return { jobId: 'provider-job' };
  };
  return { send, sent };
}

/** The route step, then the call the submit step builds from its result. */
async function gateway(ownKey: boolean, routedModelId = GROK.id) {
  const scopedDb = asStub<WorkflowScopedDb>({
    liveRead: { apiKeys: { hasUsableKey: vi.fn(async () => ownKey) } },
  });
  const routes = await routeVideoJob(scopedDb, {
    provider: 'grok',
    modelId: routedModelId,
  });
  return {
    scopedDb,
    runId: 'run-1',
    idempotencyKey: 'run-1:submit-motion',
    store: vi.fn(),
    routes,
    reservation: { id: 'run-reservation' },
  };
}

describe('sendVideoJob', () => {
  it('keeps an organization with its own key on the direct path', async () => {
    mockGenerateVideo.mockClear();
    const { send, sent } = provider();
    const job = await sendVideoJob({
      provider: 'grok',
      via: 'xai',
      modelId: GROK.id,
      threadId: 't',
      draft: false,
      usedOwnKey: false,
      gateway: await gateway(true),
      send,
    });
    expect(job).toEqual({
      jobId: 'provider-job',
      via: 'xai',
      usedOwnKey: false,
    });
    expect(sent).toHaveBeenCalledOnce();
    expect(mockGenerateVideo).not.toHaveBeenCalled();
  });

  it('sends the provider body through the gateway when it can hold it', async () => {
    mockGenerateVideo.mockClear();
    mockGenerateVideo.mockResolvedValue({ jobId: 'gateway-job' });
    const { send, sent } = provider();
    const job = await sendVideoJob({
      provider: 'grok',
      via: 'xai',
      modelId: GROK.id,
      threadId: 't',
      draft: false,
      usedOwnKey: false,
      gateway: await gateway(false),
      send,
    });
    expect(job).toEqual({
      jobId: 'gateway-job',
      via: 'openstory',
      usedOwnKey: false,
    });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({ reservation: { id: 'run-reservation' } })
    );
    expect(sent).not.toHaveBeenCalled();
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '', modelOptions: { duration: 5 } })
    );
  });

  it('holds a fal clip on its stored URLs and sends fetchable ones only when the job starts', async () => {
    mockGenerateVideo.mockClear();
    mockGenerateVideo.mockResolvedValue({ jobId: 'gateway-job' });
    transport.mockClear();
    const scopedDb = asStub<WorkflowScopedDb>({
      organizationId: 'org-1',
      liveRead: { apiKeys: { hasUsableKey: vi.fn(async () => false) } },
    });
    const routes = await routeVideoJob(scopedDb, {
      provider: 'fal',
      modelId: 'fal-ai/kling-video/o3/reference-to-video',
    });
    const held = {
      duration: 5,
      image_urls: ['/r2/talent/org-1/sheets/mara.png'],
    };
    const job = await sendVideoJob({
      provider: 'fal',
      via: 'fal',
      modelId: 'fal-ai/kling-video/o3/reference-to-video',
      threadId: 't',
      draft: false,
      usedOwnKey: false,
      gateway: {
        scopedDb,
        runId: 'run-1',
        idempotencyKey: 'run-1:submit-motion',
        store: vi.fn(),
        routes,
        reservation: null,
      },
      send: async (fetch = globalThis.fetch) => {
        await fetch('https://queue.fal.run/x', {
          method: 'POST',
          body: JSON.stringify(held),
        });
        return { jobId: 'provider-job' };
      },
    });
    expect(job.via).toBe('openstory');
    expect(mockGenerateVideo).toHaveBeenCalledWith(
      expect.objectContaining({
        modelOptions: {
          ...held,
          image_urls: [
            actualExternalUrl.stableMediaUrl(held.image_urls[0] ?? '', 'org-1'),
          ],
        },
      })
    );
    const params = transport.mock.calls[0]?.[0];
    if (!params) throw new Error('expected a gateway transport');
    await expect(params.wireBody(held)).resolves.toEqual({
      duration: 5,
      image_urls: ['https://fal.media/upload-talent/org-1/sheets/mara.png'],
    });
  });

  it('goes direct when the submit target is not the one the route step routed', async () => {
    mockGenerateVideo.mockClear();
    const { send, sent } = provider();
    const job = await sendVideoJob({
      provider: 'grok',
      via: 'xai',
      modelId: GROK.id,
      threadId: 't',
      draft: false,
      usedOwnKey: false,
      gateway: await gateway(false, 'another-model'),
      send,
    });
    expect(job.via).toBe('xai');
    expect(sent).toHaveBeenCalledOnce();
    expect(mockGenerateVideo).not.toHaveBeenCalled();
  });

  it('keeps an Ark draft or its final direct, whatever the route', async () => {
    mockGenerateVideo.mockClear();
    const { send, sent } = provider();
    const job = await sendVideoJob({
      provider: 'byteplus',
      via: 'byteplus',
      modelId: GROK.id,
      threadId: 't',
      gateway: await gateway(false),
      draft: true,
      usedOwnKey: false,
      send,
    });
    expect(job.via).toBe('byteplus');
    expect(sent).toHaveBeenCalledOnce();
    expect(mockGenerateVideo).not.toHaveBeenCalled();
  });

  it('goes direct with no gateway call (draft, final, scripts)', async () => {
    const { send, sent } = provider();
    const job = await sendVideoJob({
      provider: 'grok',
      via: 'xai',
      modelId: GROK.id,
      threadId: 't',
      draft: false,
      usedOwnKey: false,
      gateway: null,
      send,
    });
    expect(job.via).toBe('xai');
    expect(sent).toHaveBeenCalledOnce();
  });
});

describe('pollVideoJob', () => {
  it('polls an openstory job on the gateway, never on a provider', async () => {
    mockFalVideo.mockClear();
    mockGetVideoJobStatus.mockResolvedValue({
      jobId: 'gateway-job',
      status: 'processing',
    });
    const ctx = await gateway(false);
    await pollVideoJob(
      {
        jobId: 'gateway-job',
        via: 'openstory',
        endpointId: GROK.id,
        modelKey: 'grok_imagine_video_1_5',
      },
      { credentials: undefined, gateway: ctx }
    );
    expect(poller).toHaveBeenCalledOnce();
    expect(mockFalVideo).not.toHaveBeenCalled();
  });

  it('polls fal for a job with no stamp, as it was sent', async () => {
    mockFalVideo.mockClear();
    await pollVideoJob(
      {
        jobId: 'old-job',
        via: undefined,
        endpointId: undefined,
        modelKey: 'kling_v3_pro',
      },
      { credentials: undefined, gateway: null }
    );
    expect(mockFalVideo).toHaveBeenCalledWith(
      'fal-ai/kling-video/v3/pro/image-to-video',
      expect.anything()
    );
  });

  it('refuses to poll an openstory job without the gateway store', async () => {
    await expect(
      pollVideoJob(
        {
          jobId: 'gateway-job',
          via: 'openstory',
          endpointId: GROK.id,
          modelKey: 'grok_imagine_video_1_5',
        },
        { credentials: undefined, gateway: null }
      )
    ).rejects.toThrow(/without its store/);
  });
});

describe('videoGatewayStore', () => {
  it('uploads a clip by URL and refuses inline bytes', async () => {
    const upload = vi.fn(async (url: string) => ({
      url: `/r2/${url.length}.mp4`,
      path: 'p.mp4',
      contentType: 'video/mp4',
    }));
    const store = videoGatewayStore(upload);
    await expect(
      store({ url: 'https://x/a.mp4', contentType: 'video/mp4' }, 0)
    ).resolves.toEqual({
      url: '/r2/15.mp4',
      path: 'p.mp4',
      contentType: 'video/mp4',
    });
    await expect(
      store({ base64: 'AAAA', contentType: 'video/mp4' }, 0)
    ).rejects.toThrow('inline video');
  });
});

describe('a gateway clip after its run gives up or finishes (#2435)', () => {
  it('still lets the timeout surface when the release throws', async () => {
    releaseInProcessJob.mockRejectedValueOnce(new Error('D1 is down'));
    await expect(
      releaseTimedOutVideoJob(
        { jobId: '{}', via: 'openstory' },
        asStub<WorkflowScopedDb>({}),
        'timed out'
      )
    ).resolves.toBeUndefined();
    expect(releaseInProcessJob).toHaveBeenCalledOnce();
  });

  it('reads the charge off its own job row in its own step, also for a job that answered at submit', async () => {
    const getById = vi.fn(async () => ({ costMicros: 480_000 }));
    const scopedDb = asStub<WorkflowScopedDb>({
      claims: { gatewayJobs: { getById } },
    });
    const step = asStub<WorkflowStep>({
      do: (_name: string, fn: () => Promise<unknown>) => fn(),
    });
    await expect(
      readGatewayCharge(step, { jobId: '{}', via: 'openstory' }, scopedDb)
    ).resolves.toBe(480_000);
    expect(getById).toHaveBeenCalledWith('gw-1');
    await expect(
      readGatewayCharge(
        step,
        { jobId: 'done:{"jobId":"gw-2","outputs":[]}', via: 'openstory' },
        scopedDb
      )
    ).resolves.toBe(480_000);
    expect(getById).toHaveBeenLastCalledWith('gw-2');
    // A `done:` handle from before #2435 names no job.
    await expect(
      readGatewayCharge(step, { jobId: 'done:[]', via: 'openstory' }, scopedDb)
    ).resolves.toBeNull();
    await expect(
      readGatewayCharge(step, { jobId: 'x', via: 'fal' }, scopedDb)
    ).resolves.toBeNull();
  });

  it('reads a hosted clip charge for display only: an outage answers null, never fails the run', async () => {
    const step = asStub<WorkflowStep>({
      do: (_name: string, fn: () => Promise<unknown>) => fn(),
    });
    const scopedDb = asStub<WorkflowScopedDb>({});
    const job = {
      jobId: 'remote:01M8B00000000000000000JB01',
      via: 'openstory',
    };
    remoteJobCharge.mockResolvedValueOnce(12_000);
    await expect(readGatewayCharge(step, job, scopedDb)).resolves.toBe(12_000);
    remoteJobCharge.mockRejectedValueOnce(new Error('HTTP 503'));
    await expect(readGatewayCharge(step, job, scopedDb)).resolves.toBeNull();
  });

  it('sends no placeholder as a fal key: a remote route has none, and only the body capture may run without one', () => {
    expect(falApiKey({ key: 'k', source: 'platform' }, undefined)).toBe('k');
    expect(falApiKey(null, fetch)).toBe('');
    expect(() => falApiKey(null, undefined)).toThrow('no local fal key');
  });

  it('answers for the provider behind a gateway job, so Ark failures read as Ark', () => {
    expect(videoJobProviderVia({ jobId: '{}', via: 'openstory' })).toBe(
      'byteplus'
    );
    expect(videoJobProviderVia({ jobId: 'x', via: 'fal' })).toBe('fal');
    expect(videoJobProviderVia({ jobId: 'done:[]', via: 'openstory' })).toBe(
      'openstory'
    );
  });
});
