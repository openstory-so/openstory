import { describe, expect, it } from 'vitest';
import { FAQ_ITEMS, SITE_CONFIG } from './constants';
import { buildLlmsTxt } from '@/platform/server/agent/llms';

describe('SITE_CONFIG messaging (#1255)', () => {
  it('names the formats, consistent characters and iteration', () => {
    expect(SITE_CONFIG.description).toMatch(
      /films, microdramas and brand episodes/i
    );
    expect(SITE_CONFIG.description).toMatch(/consistent characters/i);
    expect(SITE_CONFIG.description).toMatch(/iterate until you nail it/i);
    expect(SITE_CONFIG.taglineSub).toMatch(
      /films, microdramas and brand episodes/i
    );
    expect(SITE_CONFIG.taglineSub).toMatch(/iterate until you nail it/i);
  });

  it('answers “What is OpenStory?” with the same two points', () => {
    const what = FAQ_ITEMS.find(
      (item) => item.question === 'What is OpenStory?'
    );
    expect(what?.answer).toMatch(/multi-scene film/i);
    expect(what?.answer).toMatch(/consistent characters/i);
    expect(what?.answer).toMatch(/iterate/i);
  });

  it('puts the same pitch in llms.txt', () => {
    const text = buildLlmsTxt();
    expect(text).toContain(SITE_CONFIG.description);
    expect(text).toMatch(/multi-scene film with consistent characters/i);
  });
});
