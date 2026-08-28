import { describe, expect, it } from 'vitest';
import { extractFalErrorMessage } from './fal-error';

function withBody(body: unknown, status = 422): Error {
  const err = new Error('Unprocessable Entity') as Error & {
    body?: unknown;
    status?: number;
  };
  err.body = body;
  err.status = status;
  return err;
}

// Verbatim 422 body returned by openai/gpt-image-2 via fal for a flagged
// prompt (captured 2026-06-11). Pinned as a regression guard: if fal changes
// the error shape, extractFalErrorMessage (and the #881 retry classification
// that keys off it) must be updated. This is the REAL prod shape — fal returns
// `{ detail: [...] }`, NOT the OpenAI-style `{ error: { message } }` that
// aimock emits in e2e replay (so the e2e can't reproduce this exact body).
const REAL_FAL_CONTENT_FLAG_422 = {
  detail: [
    {
      loc: ['body', 'prompt'],
      msg: 'The content could not be processed because it contained material flagged by a content checker.',
      type: 'content_policy_violation',
      url: 'https://docs.fal.ai/errors#content_policy_violation',
    },
  ],
};

describe('extractFalErrorMessage', () => {
  it('reads the real fal content-flag 422 detail array (prod shape)', () => {
    expect(extractFalErrorMessage(withBody(REAL_FAL_CONTENT_FLAG_422))).toBe(
      'body.prompt: The content could not be processed because it contained material flagged by a content checker.'
    );
  });

  it('reads a plain string detail', () => {
    expect(
      extractFalErrorMessage(
        withBody({ detail: 'material flagged by a content checker.' })
      )
    ).toBe('material flagged by a content checker.');
  });

  it('joins array detail messages', () => {
    expect(
      extractFalErrorMessage(
        withBody({ detail: [{ msg: 'too long' }, { msg: 'bad seed' }] })
      )
    ).toBe('too long; bad seed');
  });

  it('reads OpenAI-style { error: { message } } (aimock e2e shape)', () => {
    expect(
      extractFalErrorMessage(
        withBody({
          error: { message: 'Output audio has sensitive content.' },
        })
      )
    ).toBe('Output audio has sensitive content.');
  });

  it('reads a string { error } body', () => {
    expect(extractFalErrorMessage(withBody({ error: 'unsafe content' }))).toBe(
      'unsafe content'
    );
  });

  it('reads a top-level { message } body', () => {
    expect(extractFalErrorMessage(withBody({ message: 'boom' }))).toBe('boom');
  });

  it('falls back to error.message when no structured body is present', () => {
    expect(extractFalErrorMessage(new Error('plain failure'))).toBe(
      'plain failure'
    );
  });

  it('stringifies non-Error inputs', () => {
    expect(extractFalErrorMessage('just a string')).toBe('just a string');
  });
});
