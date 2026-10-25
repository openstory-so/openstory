import { describe, expect, it } from 'vitest';
import { parseStudioComposerPrefs } from './composer-prefs';

describe('parseStudioComposerPrefs', () => {
  it('keeps a draft-off choice', () => {
    expect(parseStudioComposerPrefs({ draft: false })).toEqual({
      draft: false,
    });
  });

  it('keeps every valid field', () => {
    const prefs = {
      aspectRatio: '9:16',
      resolution: '1080p',
      count: 2,
      duration: 'auto',
      generateAudio: false,
      draft: true,
    };
    expect(parseStudioComposerPrefs(prefs)).toEqual(prefs);
  });

  it('drops only the fields that no longer parse', () => {
    expect(
      parseStudioComposerPrefs({
        videoModel: 'retired_model',
        imageModel: 42,
        aspectRatio: '4:3',
        count: 3,
        duration: -1,
        draft: false,
      })
    ).toEqual({ draft: false });
  });

  it('treats junk as no saved settings', () => {
    expect(parseStudioComposerPrefs(null)).toEqual({});
    expect(parseStudioComposerPrefs('draft')).toEqual({});
    expect(parseStudioComposerPrefs([1])).toEqual({});
  });
});
