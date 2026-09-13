import { describe, expect, it } from 'vitest';
import {
  EMPTY_GENERATION_PROMPT_MESSAGE,
  isBlankPrompt,
  requireGenerationPrompt,
} from './generation-prompt';

describe('isBlankPrompt', () => {
  it('treats missing, empty, and whitespace as empty', () => {
    expect(isBlankPrompt(undefined)).toBe(true);
    expect(isBlankPrompt(null)).toBe(true);
    expect(isBlankPrompt('')).toBe(true);
    expect(isBlankPrompt('   ')).toBe(true);
    expect(isBlankPrompt('\n\t')).toBe(true);
  });

  it('treats any non-whitespace content as present', () => {
    expect(isBlankPrompt('wide shot')).toBe(false);
    expect(isBlankPrompt('  wide shot  ')).toBe(false);
  });
});

describe('requireGenerationPrompt', () => {
  it('refuses an empty or whitespace override even when a stored prompt exists', () => {
    expect(() => requireGenerationPrompt('', 'stored prompt')).toThrow(
      EMPTY_GENERATION_PROMPT_MESSAGE
    );
    expect(() => requireGenerationPrompt('  ', 'stored prompt')).toThrow(
      EMPTY_GENERATION_PROMPT_MESSAGE
    );
  });

  it('refuses when no override is sent and the stored prompt is empty', () => {
    expect(() => requireGenerationPrompt(undefined, undefined)).toThrow(
      EMPTY_GENERATION_PROMPT_MESSAGE
    );
    expect(() => requireGenerationPrompt(undefined, '')).toThrow(
      EMPTY_GENERATION_PROMPT_MESSAGE
    );
    expect(() => requireGenerationPrompt(undefined, '  ')).toThrow(
      EMPTY_GENERATION_PROMPT_MESSAGE
    );
  });

  it('accepts a non-empty override or a non-empty stored prompt', () => {
    expect(() => requireGenerationPrompt('wide shot', undefined)).not.toThrow();
    expect(() => requireGenerationPrompt(undefined, 'wide shot')).not.toThrow();
  });
});
