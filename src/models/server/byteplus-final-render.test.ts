import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch =
  vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
vi.doMock('@/models/server/byteplus-config', () => ({
  getArkApiKey: () => 'ark-key',
  arkAdapterConfig: () => ({
    apiKey: 'ark-key',
    timeout: 5_000,
    fetch: mockFetch,
    baseURL: 'https://ark.test/api/v3',
  }),
}));
vi.doMock('@/models/server/quota-retry', () => ({
  withBytePlusQuotaRetry: (_label: string, fn: () => Promise<unknown>) => fn(),
}));
vi.doMock('@tanstack/ai-byteplus', () => ({
  withBytePlusArkDefaults: (config: Record<string, unknown>) => config,
  bytePlusArkHeaders: (apiKey: string) => ({
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }),
  bytePlusArkError: (status: number, body: unknown) =>
    new Error(`ark ${status}: ${JSON.stringify(body)}`),
}));

const { submitBytePlusFinalRender } = await import('./byteplus-final-render');

describe('submitBytePlusFinalRender', () => {
  beforeEach(() => mockFetch.mockReset());

  it('sends only the draft task id, at 1080p, to the same model', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ id: 'cgt-final' }), { status: 200 })
    );

    const result = await submitBytePlusFinalRender({
      modelId: 'dreamina-seedance-2-5-260628',
      draftTaskId: 'cgt-draft',
      label: 'test',
    });

    expect(result).toEqual({ jobId: 'cgt-final' });
    const call = mockFetch.mock.calls[0];
    expect(call?.[0]).toBe(
      'https://ark.test/api/v3/contents/generations/tasks'
    );
    expect(call?.[1].method).toBe('POST');
    const body = call?.[1].body;
    expect(typeof body).toBe('string');
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({
      model: 'dreamina-seedance-2-5-260628',
      content: [{ type: 'draft_task', draft_task: { id: 'cgt-draft' } }],
      resolution: '1080p',
      watermark: false,
    });
  });

  it('surfaces an Ark rejection as an Ark error — no fresh render', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'DraftExpired' } }), {
        status: 400,
      })
    );
    await expect(
      submitBytePlusFinalRender({
        modelId: 'dreamina-seedance-2-5-260628',
        draftTaskId: 'cgt-old',
        label: 'test',
      })
    ).rejects.toThrow(/ark 400/);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
