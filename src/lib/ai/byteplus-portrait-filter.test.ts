import { describe, expect, it } from 'vitest';
import {
  BYTEPLUS_PORTRAIT_FILTER_NO_FAL_MESSAGE,
  isBytePlusPortraitFilterError,
} from './byteplus-portrait-filter';

const USER_ERROR =
  "BytePlus Ark video task creation failed (400 InputImageSensitiveContentDetected.PrivacyInformation): The request failed because the input image 'content[1]' may contain real person. Request id: 02178780432326311300f35b2a874e35aceb4d35afb57b86c9805";

describe('isBytePlusPortraitFilterError', () => {
  it('matches the exact Ark 400 the user hit', () => {
    expect(isBytePlusPortraitFilterError(new Error(USER_ERROR))).toBe(true);
  });

  it('matches a wrapper that kept only the human sentence', () => {
    expect(
      isBytePlusPortraitFilterError(
        new Error(
          "The request failed because the input image 'content[1]' may contain real person."
        )
      )
    ).toBe(true);
  });

  it('does not treat output moderation or text filters as the same 400', () => {
    expect(
      isBytePlusPortraitFilterError(
        new Error(
          'BytePlus Ark video task creation failed (400 OutputVideoSensitiveContentDetected): sensitive output'
        )
      )
    ).toBe(false);
    expect(
      isBytePlusPortraitFilterError(
        new Error(
          'BytePlus Ark video task creation failed (400 InputTextSensitiveContentDetected): flagged prompt'
        )
      )
    ).toBe(false);
    expect(
      isBytePlusPortraitFilterError(
        new Error(
          'BytePlus Ark video task creation failed (400 InvalidParameter)'
        )
      )
    ).toBe(false);
  });

  it('handles non-Error values', () => {
    expect(isBytePlusPortraitFilterError(USER_ERROR)).toBe(true);
    expect(isBytePlusPortraitFilterError(undefined)).toBe(false);
  });

  it('keeps the no-fal message as something the UI can show', () => {
    expect(BYTEPLUS_PORTRAIT_FILTER_NO_FAL_MESSAGE).toMatch(/asset:\/\//);
    expect(BYTEPLUS_PORTRAIT_FILTER_NO_FAL_MESSAGE).toMatch(/FAL_KEY/);
  });
});
