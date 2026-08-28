import { describe, expect, it } from 'vitest';
import {
  CONTENT_REJECTION_PATTERNS,
  clipContentRejectionMessage,
  flaggedInputs,
  contentRejectionSubjects,
  contentRejectionSummary,
  isContentRejectionError,
} from './content-rejection';

/** Build a fal-shaped ApiError (422 with `body.detail`) like the client throws. */
function falError(detail: string, status = 422): Error {
  const err = new Error('Unprocessable Entity') as Error & {
    body?: { detail?: string };
    status?: number;
  };
  err.body = { detail };
  err.status = status;
  return err;
}

describe('isContentRejectionError', () => {
  it('matches the observed provider rejection strings (#881)', () => {
    const observed = [
      'The content could not be processed because it contained material flagged by a content checker.',
      'material flagged by a content checker.',
      'The model did not generate the expected output for this prompt. It may contain unsafe content.',
      'Could not generate images with the given prompts and images. Please try again with different inputs.',
      'Unexpected result from the model.',
      'Output audio has sensitive content.',
    ];
    for (const message of observed) {
      expect(isContentRejectionError(new Error(message)), message).toBe(true);
    }
  });

  it('matches when the message is wrapped in a fal ApiError body.detail', () => {
    expect(
      isContentRejectionError(
        falError('material flagged by a content checker.')
      )
    ).toBe(true);
  });

  it('classifies the real fal content-flag 422 (openai/gpt-image-2, captured 2026-06-11)', () => {
    const err = new Error('Unprocessable Entity') as Error & {
      body?: unknown;
      status?: number;
    };
    err.body = {
      detail: [
        {
          loc: ['body', 'prompt'],
          msg: 'The content could not be processed because it contained material flagged by a content checker.',
          type: 'content_policy_violation',
          url: 'https://docs.fal.ai/errors#content_policy_violation',
        },
      ],
    };
    err.status = 422;
    expect(isContentRejectionError(err)).toBe(true);
  });

  it('does not misclassify infrastructure / transient errors', () => {
    const transient = [
      'fetch failed',
      'Fal API error: 503 Service Unavailable',
      'Motion generation timed out after 30 minutes',
      'D1_ERROR: database is locked',
      'No URL returned',
      // Provenance 400 — submit falls back to fal; a reseed cannot help.
      "BytePlus Ark video task creation failed (400 InputImageSensitiveContentDetected.PrivacyInformation): The request failed because the input image 'content[1]' may contain real person.",
    ];
    for (const message of transient) {
      expect(isContentRejectionError(new Error(message)), message).toBe(false);
    }
  });

  it('handles non-Error inputs without throwing', () => {
    expect(isContentRejectionError(undefined)).toBe(false);
    expect(isContentRejectionError('unsafe content detected')).toBe(true);
  });

  it('exposes a non-empty pattern list', () => {
    expect(CONTENT_REJECTION_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('contentRejectionSummary / contentRejectionSubjects', () => {
  it('collapses content-only failures to the names and reads them back (#1293)', () => {
    const summary = contentRejectionSummary([
      { name: 'Ron Weasley', reason: 'material flagged by a content checker.' },
      {
        name: 'Harry Potter',
        reason: 'Character sheet rejected by content filter after 3 attempts',
      },
    ]);
    expect(summary).toBe(
      'Blocked by the content checker: Ron Weasley, Harry Potter'
    );
    expect(isContentRejectionError(summary)).toBe(true);
    // Parents only prefix; the tail survives a 500-char truncation ellipsis.
    expect(
      contentRejectionSubjects(
        `Child workflow analyze-script:1 failed: Character sheet generation failed: Child workflow character-bible:1 failed: ${summary}…`
      )
    ).toEqual(['Ron Weasley', 'Harry Potter']);
  });

  it('is null when any failure is not a content rejection', () => {
    expect(
      contentRejectionSummary([
        {
          name: 'Ron Weasley',
          reason: 'material flagged by a content checker.',
        },
        { name: 'Harry Potter', reason: 'ECONNRESET' },
      ])
    ).toBeNull();
    expect(contentRejectionSummary([])).toBeNull();
    expect(contentRejectionSubjects('Generation failed')).toEqual([]);
  });
});

describe('flaggedInputs / clipContentRejectionMessage (#1373)', () => {
  // The real LTX 2.3 Pro 422 from shot 01M0YXMK5BCZEKQ5TSZ4CPT51C, as
  // `extractFalErrorMessage` renders it (loc-prefixed, `; `-joined).
  const both =
    'body.prompt: The content could not be processed because it contained material flagged by a content checker.; body.image_url: The content could not be processed because it contained material flagged by a content checker.';

  it('names the still and the prompt separately', () => {
    expect(flaggedInputs(both)).toEqual({
      prompt: true,
      image: true,
      audio: false,
    });
    expect(flaggedInputs('body.prompt: flagged by a content checker')).toEqual({
      prompt: true,
      image: false,
      audio: false,
    });
    expect(flaggedInputs('body.image_urls.0: flagged')).toMatchObject({
      image: true,
    });
    expect(flaggedInputs('Output audio has sensitive content.')).toEqual({
      prompt: false,
      image: false,
      audio: false,
    });
  });

  it('tells the user what was rejected, by whom, and what to change', () => {
    const message = clipContentRejectionMessage({
      rejections: [both],
      models: ['LTX 2.3 Pro', 'Grok Imagine Video 1.5'],
      softened: true,
    });
    expect(message).toBe(
      'Content checker rejected the still and the prompt (LTX 2.3 Pro, then Grok Imagine Video 1.5; softened prompt also rejected). Regenerate the still or rewrite the motion prompt.'
    );
    expect(isContentRejectionError(message)).toBe(true);

    expect(
      clipContentRejectionMessage({
        rejections: ['body.image_url: flagged by a content checker'],
        models: ['LTX 2.3 Pro'],
        softened: false,
      })
    ).toBe(
      'Content checker rejected the still (LTX 2.3 Pro). Regenerate the still.'
    );

    expect(
      clipContentRejectionMessage({
        rejections: [
          'Could not generate images with the given prompts and images.',
        ],
        models: ['Veo 3.1'],
        softened: true,
      })
    ).toBe(
      'Content checker rejected the clip (Veo 3.1; softened prompt also rejected). Rewrite the motion prompt or regenerate the still. (Could not generate images with the given prompts and images.)'
    );
  });

  it('keeps what the first attempts named when the rescue rejection is unprefixed', () => {
    expect(
      clipContentRejectionMessage({
        rejections: [both, both, both, 'unsafe content'],
        models: ['LTX 2.3 Pro', 'Grok Imagine Video 1.5'],
        softened: true,
      })
    ).toMatch(/^Content checker rejected the still and the prompt \(/);
  });

  it('names studio inputs — a reference image, or nothing but the prompt', () => {
    expect(
      clipContentRejectionMessage({
        rejections: ['body.image_urls.0: flagged by a content checker'],
        models: ['Seedance 2.5'],
        softened: false,
        inputs: {
          still: { name: 'a reference image', fix: 'Swap the reference image' },
          prompt: 'the prompt',
        },
      })
    ).toBe(
      'Content checker rejected a reference image (Seedance 2.5). Swap the reference image.'
    );
    // No reference image was sent, so there is nothing but the prompt to fix.
    expect(
      clipContentRejectionMessage({
        rejections: ['flagged by a content checker'],
        models: ['Seedance 2.5'],
        softened: false,
        inputs: { prompt: 'the prompt' },
      })
    ).toBe(
      'Content checker rejected the clip (Seedance 2.5). Rewrite the prompt. (flagged by a content checker)'
    );
  });
});
