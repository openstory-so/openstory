import { describe, expect, it } from 'vitest';
import { buildLlmsTxt } from './llms';

describe('llms.txt', () => {
  it('points agents at the MCP guide', () => {
    expect(buildLlmsTxt()).toContain('/docs/developer-guide/agents');
  });
});
