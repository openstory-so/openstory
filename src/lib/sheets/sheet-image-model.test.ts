import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { resolveSheetImageModel } from './sheet-image-model';

describe('resolveSheetImageModel', () => {
  it('prefers an explicit valid pick', () => {
    expect(
      resolveSheetImageModel({
        explicit: 'grok_imagine_image',
        liveVersionModel: 'nano_banana_2',
        sequenceImageModel: 'nano_banana_2',
      })
    ).toBe('grok_imagine_image');
  });

  it('uses the live generated model when there is no explicit pick', () => {
    expect(
      resolveSheetImageModel({
        liveVersionModel: 'grok_imagine_image',
        sequenceImageModel: 'nano_banana_2',
      })
    ).toBe('grok_imagine_image');
  });

  it('ignores user-upload / prior and falls through to the live generated model', () => {
    expect(
      resolveSheetImageModel({
        explicit: 'user-upload',
        liveVersionModel: 'nano_banana_2',
        sequenceImageModel: 'flux_2_dev',
      })
    ).toBe('nano_banana_2');
  });

  it('uses the sequence default when there is no generated version', () => {
    expect(
      resolveSheetImageModel({
        liveVersionModel: 'prior',
        sequenceImageModel: 'nano_banana_2',
      })
    ).toBe('nano_banana_2');
  });

  it('falls back to the app default when nothing is valid', () => {
    expect(
      resolveSheetImageModel({
        liveVersionModel: 'user-upload',
        sequenceImageModel: null,
      })
    ).toBe(DEFAULT_IMAGE_MODEL);
  });
});
