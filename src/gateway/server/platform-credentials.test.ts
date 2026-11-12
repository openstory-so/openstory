/**
 * A gateway job spends platform keys only. The credentials hold no database
 * handle, so an organization's own key cannot be reached; the workflow source
 * never touches `scopedDb.credentials` or `scopedDb.apiKeys`.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const env: Record<string, string | undefined> = {
  FAL_KEY: 'platform-fal',
  GEMINI_API_KEY: 'platform-gemini',
  XAI_API_KEY: '',
  OPENROUTER_KEY: 'platform-openrouter',
};
vi.doMock('#env', () => ({ getEnv: () => env }));

const { platformOnlyCredentials } = await import('./platform-credentials');

describe('platformOnlyCredentials', () => {
  const credentials = platformOnlyCredentials({
    organizationId: 'org-1',
    userId: 'user-1',
  });

  it('resolves the platform key, marked platform', async () => {
    expect(await credentials.resolveKey('fal')).toEqual({
      key: 'platform-fal',
      source: 'platform',
    });
    expect(await credentials.resolveOptionalKey('google')).toEqual({
      key: 'platform-gemini',
      source: 'platform',
    });
  });

  it('never falls back to an organization key the platform lacks', async () => {
    expect(await credentials.resolveOptionalKey('xai')).toBeUndefined();
    expect(await credentials.resolveOptionalKey('llmtr')).toBeUndefined();
    await expect(credentials.resolveKey('xai')).rejects.toThrow(
      'No platform key for provider: xai'
    );
  });

  it('carries the run identity and nothing else', () => {
    expect(Object.keys(credentials).sort()).toEqual([
      'organizationId',
      'resolveKey',
      'resolveOptionalKey',
      'userId',
    ]);
  });
});

describe('gateway sources', () => {
  it('never reach organization credentials', () => {
    for (const path of [
      'src/gateway/server/workflows/gateway-generation-workflow.ts',
      'src/gateway/server/submit-job.ts',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/scopedDb\s*\.\s*credentials/);
      expect(source, path).not.toMatch(/scopedDb\s*\.\s*apiKeys/);
    }
  });
});
