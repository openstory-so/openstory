import { describe, expect, it } from 'vitest';
import { USER_UPLOAD_MODEL } from '@/lib/shots/upload-media';
import { isSetImageOffered } from './set-image-offer';

const base = {
  variantCompleted: true,
  currentImageUrl: 'https://cdn.example/still.png',
  currentKind: 'model',
  currentModel: 'nano_banana_2',
  dropdownModel: 'nano_banana_2',
};

describe('isSetImageOffered', () => {
  it('hides Set Image when the current still is from the dropdown model', () => {
    expect(isSetImageOffered(base)).toBe(false);
  });

  it('offers Set Image when the dropdown model has a completed still that is not current', () => {
    expect(
      isSetImageOffered({ ...base, dropdownModel: 'grok_imagine_image' })
    ).toBe(true);
  });

  it('hides Set Image when the current still is a user upload', () => {
    expect(
      isSetImageOffered({
        ...base,
        currentKind: 'upload',
        currentModel: USER_UPLOAD_MODEL,
        dropdownModel: 'grok_imagine_image',
      })
    ).toBe(false);
  });

  it('hides Set Image when the current model is the upload sentinel', () => {
    expect(
      isSetImageOffered({
        ...base,
        currentKind: 'model',
        currentModel: USER_UPLOAD_MODEL,
        dropdownModel: 'nano_banana_2',
      })
    ).toBe(false);
  });

  it('hides Set Image when there is no completed variant to promote', () => {
    expect(isSetImageOffered({ ...base, variantCompleted: false })).toBe(false);
  });

  it('hides Set Image when the shot has no current still', () => {
    expect(isSetImageOffered({ ...base, currentImageUrl: null })).toBe(false);
  });
});
