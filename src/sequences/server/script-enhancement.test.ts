import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/platform/server/ai/prompts-index';

const getRequestHeader = vi.fn<(name: string) => string | undefined>();
vi.doMock('@tanstack/react-start/server', () => ({ getRequestHeader }));

const callLLMStream = vi.fn((_params: { messages: ChatMessage[] }) => ({
  async *[Symbol.asyncIterator]() {
    yield { delta: 'Scene 1 — 30s\nA cyclist races home.\nTOTAL: 30s' };
  },
}));
vi.doMock('@/models/server/llm-client', () => ({
  callLLMStream,
  ENHANCE_REASONING: 'low',
  RECOMMENDED_MODELS: { creative: 'x-ai/grok-4.6' },
  llmCostFromUsage: vi.fn(() => 0),
}));

const { streamScriptEnhancement, enhanceScriptToString } =
  await import('./script-enhancement');

function context(): Parameters<typeof streamScriptEnhancement>[1] {
  return {
    scopedDb: {
      apiKeys: {
        resolveLlmKey: async () => ({
          source: 'team',
          via: 'openrouter',
          key: 'team-key',
        }),
      },
      billing: {
        hasEnoughCredits: async () => true,
        deductCredits: async () => undefined,
      },
    },
    userId: 'u1',
    teamId: 't1',
  };
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
