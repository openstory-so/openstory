import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_MODEL } from '@/models/models.config';
import { REGION_FALLBACK_MODEL } from '@/models/region-policy';
import { chatModelFor } from './chat-model';

describe('chatModelFor', () => {
  it('takes a selectable model, defaults with none, refuses anything else', () => {
    expect(chatModelFor('anthropic/claude-sonnet-5.5', undefined)).toBe(
      'anthropic/claude-sonnet-5.5'
    );
    expect(chatModelFor(undefined, undefined)).toBe(DEFAULT_ANALYSIS_MODEL);
    expect(() => chatModelFor('nope/model', undefined)).toThrow(
      'not one the assistant can run on'
    );
    expect(() => chatModelFor(null, undefined)).toThrow();
  });

  it('swaps a blocked vendor for the country, like a sequence does', () => {
    expect(chatModelFor('anthropic/claude-sonnet-5.5', 'CN')).toBe(
      REGION_FALLBACK_MODEL
    );
  });
});
