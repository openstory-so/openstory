import { describe, expect, it } from 'vitest';
import { assertSingleShotSegmentForVideoUpload } from '@/functions/media-upload';
import { requireWritableScene } from '@/functions/shots';
import { NotFoundError, ValidationError } from '@/lib/errors';

describe('requireWritableScene', () => {
  const sequenceId = 'seq-1';

  it('accepts a live scene in this sequence', () => {
    expect(() =>
      requireWritableScene({ sequenceId, deletedAt: null }, sequenceId)
    ).not.toThrow();
  });

  it('rejects a missing scene, a foreign sequence, or a soft-deleted scene', () => {
    expect(() => requireWritableScene(null, sequenceId)).toThrow(NotFoundError);
    expect(() =>
      requireWritableScene(
        { sequenceId: 'seq-other', deletedAt: null },
        sequenceId
      )
    ).toThrow(NotFoundError);
    expect(() =>
      requireWritableScene({ sequenceId, deletedAt: new Date() }, sequenceId)
    ).toThrow(NotFoundError);
  });
});

describe('assertSingleShotSegmentForVideoUpload', () => {
  it('allows a per-shot segment', () => {
    expect(() => assertSingleShotSegmentForVideoUpload(1)).not.toThrow();
    expect(() => assertSingleShotSegmentForVideoUpload(0)).not.toThrow();
  });

  it('refuses a multi-shot scene render', () => {
    expect(() => assertSingleShotSegmentForVideoUpload(2)).toThrow(
      ValidationError
    );
  });
});
