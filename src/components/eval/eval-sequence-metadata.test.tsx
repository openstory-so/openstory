import { CREDITS_SHORT_TITLE } from '@/lib/billing/credits-short';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  SequenceListStatus,
  sequenceListFailure,
} from './eval-sequence-metadata';

const creditsError =
  'Not enough credits to generate images for 11 scenes. Add $4.20 more, then continue.';

const failedShot = {
  frame: { imageStatus: 'failed' as const },
  videoStatus: 'pending' as const,
};

describe('sequenceListFailure', () => {
  it('treats a reservation-short failed sequence as credits, not an error (#1328)', () => {
    expect(
      sequenceListFailure({
        status: 'failed',
        statusError: creditsError,
        musicError: null,
        shots: [],
      })
    ).toEqual({ creditsShort: true, errorCount: 0 });
  });

  it('still counts a real generation failure as an error', () => {
    expect(
      sequenceListFailure({
        status: 'failed',
        statusError: 'Child workflow scene-split failed',
        musicError: null,
        shots: [],
      })
    ).toEqual({ creditsShort: false, errorCount: 1 });
  });

  it('counts shot failures even when the sequence is credits-short', () => {
    expect(
      sequenceListFailure({
        status: 'failed',
        statusError: creditsError,
        musicError: null,
        shots: [failedShot],
      })
    ).toEqual({ creditsShort: true, errorCount: 1 });
  });
});

describe('SequenceListStatus', () => {
  it('renders a muted top-up line instead of a red error icon', () => {
    const html = renderToStaticMarkup(
      <SequenceListStatus
        sequence={{
          status: 'failed',
          statusError: creditsError,
          musicError: null,
          shots: [],
        }}
      />
    );

    expect(html).toContain(CREDITS_SHORT_TITLE);
    expect(html).toContain('text-muted-foreground');
    expect(html).not.toContain('1 error');
    expect(html).not.toContain('text-destructive');
  });

  it('keeps the red error icon for real generation failures', () => {
    const html = renderToStaticMarkup(
      <SequenceListStatus
        sequence={{
          status: 'failed',
          statusError: 'Child workflow scene-split failed',
          musicError: null,
          shots: [],
        }}
      />
    );

    expect(html).toContain('1 error');
    expect(html).toContain('text-destructive');
    expect(html).not.toContain(CREDITS_SHORT_TITLE);
  });
});
