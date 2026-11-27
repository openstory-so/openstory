import { describe, expect, it, vi } from 'vitest';
import { streamGatewayChat } from './chat';

const body = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  maxTokens: 64,
};

const scope = () => ({
  apiKeys: { resolvePlatformLlmKey: vi.fn(async () => null) },
});

describe('streamGatewayChat', () => {
  it('refuses a model OpenStory does not run', async () => {
    await expect(
      streamGatewayChat(scope(), 'vendor/unknown', body, null)
    ).rejects.toThrow('Unknown model');
  });

  it('refuses a budget above what the model can write', async () => {
    await expect(
      streamGatewayChat(
        scope(),
        'anthropic/claude-sonnet-5.5',
        {
          ...body,
          maxTokens: 10_000_000,
        },
        null
      )
    ).rejects.toThrow('maxTokens');
  });

  it('refuses a model the card cannot price, and never runs it direct', async () => {
    const db = scope();
    await expect(
      streamGatewayChat(db, 'anthropic/claude-sonnet-5.5', body, null)
    ).rejects.toThrow('cannot be priced');
    expect(db.apiKeys.resolvePlatformLlmKey).toHaveBeenCalledOnce();
  });
});
