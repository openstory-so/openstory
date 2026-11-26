/** The video job's route (own key, gateway, direct) and the poll that follows the stamp. */

import { describe, expect, it, vi } from 'vitest';
import type { GatewayModel } from '@/gateway/server/catalog';
import type { WorkflowScopedDb } from '@/platform/server/db/scoped-workflow';
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
const transport = vi.fn();
vi.doMock('@/gateway/server/adapter/in-process', () => ({
  inProcessGateway: (params: unknown) => {
    transport(params);
    return { submit: vi.fn(), status: vi.fn() };
  },
  inProcessPoller: () => {
    poller();
    return { status: vi.fn() };
  },
}));
vi.doMock('#env', () => ({ getEnv: () => ({ FAL_KEY: 'platform-fal' }) }));

const { pollVideoJob, routeVideoJob, sendVideoJob, videoGatewayStore } =
  await import('./video-job');

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
