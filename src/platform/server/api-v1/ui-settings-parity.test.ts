/**
 * Every setting the app sends is a field on the API and MCP (#2084).
 *
 * The two maps are typed against the UI's own types, so a new composer
 * setting or Continue switch with no entry fails the typecheck; the tests
 * then check each named field really is on the schema. A setting the API
 * leaves out on purpose says why.
 */
import { describe, expect, it } from 'vitest';
import type { GenerationSettings } from '@/sequences/ui/use-generation-settings';
import type { ContinueFlags } from '@/sequences/ui/use-sequences';
import { planGenerationInput } from '../mcp/tools/generation';
import { apiCreateSequenceSchema } from './input-schema';

type ApiField<F extends string> = F | { readonly notOnApi: string };

const CREATE = {
  aspectRatio: 'aspectRatio',
  resolution: 'resolution',
  analysisModels: 'analysisModels',
  imageModels: 'imageModels',
  videoModels: 'videoModels',
  audioModels: 'audioModels',
  stopAt: 'stopAt',
  generateStartFrames: 'startFrames',
  draftMotion: 'draftMotion',
  imageModel: { notOnApi: 'the first of imageModels' },
  motionModel: { notOnApi: 'the first of videoModels' },
  musicModel: { notOnApi: 'the first of audioModels' },
  generationMode: { notOnApi: 'a composer preset that fills the model lists' },
  rememberStopAt: { notOnApi: 'skips a composer dialog' },
  generateVoices: { notOnApi: 'not a caller choice (#2067)' },
} as const satisfies Record<
  keyof GenerationSettings,
  ApiField<keyof typeof apiCreateSequenceSchema.shape>
>;

const CONTINUE = {
  stopAt: 'stopAt',
  generateStartFrames: 'startFrames',
  draftMotion: 'draftMotion',
  generateVoices: { notOnApi: 'not a caller choice (#2067)' },
} as const satisfies Record<
  keyof ContinueFlags,
  ApiField<keyof typeof planGenerationInput.shape>
>;

const fields = (map: Record<string, ApiField<string>>) =>
  Object.values(map).filter((f) => typeof f === 'string');

describe('UI settings on the API and MCP', () => {
  it('create takes every new-sequence setting', () => {
    expect(Object.keys(apiCreateSequenceSchema.shape)).toEqual(
      expect.arrayContaining(fields(CREATE))
    );
  });

  it('plan_generation takes every Continue switch', () => {
    expect(Object.keys(planGenerationInput.shape)).toEqual(
      expect.arrayContaining(fields(CONTINUE))
    );
  });

  it('create defaults match the app: no start frames, drafts first', () => {
    const parsed = apiCreateSequenceSchema.parse({ script: 'x'.repeat(10) });
    expect(parsed.startFrames).toBe(false);
    expect(parsed.draftMotion).toBe(true);
  });
});
