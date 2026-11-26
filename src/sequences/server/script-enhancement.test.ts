import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/platform/server/ai/prompts-index';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { asStub } from '@/test/as-stub';

const getRequestHeader = vi.fn<(name: string) => string | undefined>();
vi.doMock('@tanstack/react-start/server', () => ({ getRequestHeader }));

const callLLMStream = vi.fn(
  (_params: {
    messages: ChatMessage[];
    apiKey: { meter: unknown };
    resolveApiKey?: () => Promise<unknown>;
  }) => ({
    async *[Symbol.asyncIterator]() {
      yield { delta: 'Scene 1 — 30s\nA cyclist races home.\nTOTAL: 30s' };
    },
  })
);
vi.doMock('@/models/server/llm-client', () => ({
  callLLMStream,
  ENHANCE_REASONING: 'low',
  RECOMMENDED_MODELS: { creative: 'x-ai/grok-4.7' },
  llmCostFromUsage: vi.fn(() => 0),
}));

const releaseGeminiFiles = vi.fn(async () => {});
vi.doMock('@/models/server/gemini-files', () => ({
  geminiStillSource: vi.fn(
    async (_url: string, _key: string, uploaded: Array<{ name: string }>) => {
      uploaded.push({ name: 'files/big' });
      return { type: 'url', value: 'https://files.example/big' };
    }
  ),
  releaseGeminiFiles,
}));

const { streamScriptEnhancement, enhanceScriptToString, prepareBilling } =
  await import('./script-enhancement');

function context() {
  // only the organization-key billing preflight is reached
  const scopedDb = asStub<ScopedDb>({
    apiKeys: {
      resolveLlmKey: vi.fn(async () => ({
        source: 'organization',
        via: 'openrouter',
        meter: { uncharged: 'own key' },
      })),
    },
  });
  return { scopedDb, userId: 'u1', organizationId: 't1' };
}

beforeEach(() => {
  getRequestHeader.mockReset();
  callLLMStream.mockClear();
});

describe('Enhance user location', () => {
  it.each([
    [' au ', 'AU'],
    [undefined, ''],
    ['XX', ''],
    ['T1', ''],
  ])(
    'compiles request country %s into the streaming prompt',
    async (header, expected) => {
      getRequestHeader.mockReturnValue(header);
      const script = 'A British visitor cycles through Tokyo.';

      let result = '';
      for await (const chunk of streamScriptEnhancement(
        { script },
        context()
      )) {
        result += chunk.delta;
      }

      expect(result).toContain('A cyclist races home.');
      expect(getRequestHeader).toHaveBeenCalledWith('cf-ipcountry');
      const messages = callLLMStream.mock.calls[0]?.[0].messages;
      expect(messages?.[0]?.content).toContain(
        `User country (ISO country code; unavailable when empty): ${expected}\n`
      );
      expect(messages?.[0]?.content).not.toContain('{{userCountry}}');
      expect(messages?.[1]?.content).toContain(script);
    }
  );

  it('also passes the country when the API invents a script from scratch', async () => {
    getRequestHeader.mockReturnValue('NZ');

    await enhanceScriptToString({ script: '', invent: true }, context());

    const messages = callLLMStream.mock.calls[0]?.[0].messages;
    expect(messages?.[0]?.content).toContain(
      'User country (ISO country code; unavailable when empty): NZ\n'
    );
    expect(messages?.[1]?.content).toContain('Invent an original short video');
  });
});

describe('Enhance with a still on the Gemini Files API (#2400)', () => {
  it('never re-runs off Google, and deletes the still afterwards', async () => {
    const scopedDb = asStub<ScopedDb>({
      apiKeys: {
        resolveLlmKey: vi.fn(async () => ({
          source: 'organization',
          via: 'google',
          key: 'g',
          meter: { uncharged: 'own key' },
        })),
      },
    });
    await enhanceScriptToString(
      {
        script: 'A cyclist races home.',
        elements: [{ token: 'BIKE', imageUrl: '/r2/stills/bike.png' }],
      },
      { scopedDb, userId: 'u1', organizationId: 't1' }
    );

    const params = callLLMStream.mock.calls[0]?.[0];
    await expect(params?.resolveApiKey?.()).rejects.toThrow(
      "Gemini isn't available from this region."
    );
    expect(releaseGeminiFiles).toHaveBeenCalledWith(
      [{ name: 'files/big' }],
      'g'
    );
  });
});

describe('Enhance on an unfunded script (#1567)', () => {
  it('lets its own hold decide, running free when the balance cannot take it, with no credit pre-check', async () => {
    const hasEnoughCredits = vi.fn(async () => false);
    const scopedDb = asStub<ScopedDb>({
      apiKeys: {
        resolveLlmKey: vi.fn(async () => ({
          key: 'p',
          source: 'platform',
          via: 'openrouter',
          meter: {
            via: 'openrouter',
            card: null,
            chargeKey: null,
            whenShort: 'refuse',
            describe: null,
            resolve: vi.fn(),
          },
        })),
      },
      billing: { hasEnoughCredits },
    });
    await enhanceScriptToString(
      { script: 'A cyclist races home.' },
      { scopedDb, userId: 'u1', organizationId: 't1' }
    );
    const meter = callLLMStream.mock.calls[0]?.[0].apiKey.meter;
    expect(meter).toMatchObject({ whenShort: 'run free' });
    expect(
      typeof meter === 'object' &&
        meter !== null &&
        'describe' in meter &&
        typeof meter.describe === 'function' &&
        meter.describe('x-ai/grok-4.7')
    ).toBe('Script enhancement');
    expect(hasEnoughCredits).not.toHaveBeenCalled();
  });
});

describe('a hosted gateway key (#2438)', () => {
  it('skips the local balance check: the hosted side checks and charges', async () => {
    const hasEnoughCredits = vi.fn(async () => false);
    const hosted = {
      key: '',
      source: 'platform',
      via: 'openstory',
      meter: { uncharged: 'hosted gateway' },
    };
    const scopedDb = asStub<ScopedDb>({
      apiKeys: { resolveLlmKey: vi.fn(async () => hosted) },
      billing: { hasEnoughCredits },
    });
    expect(
      (await prepareBilling(scopedDb, 'Prompt shortening')).llmKey
    ).toEqual(hosted);
    expect(hasEnoughCredits).not.toHaveBeenCalled();
  });
});
