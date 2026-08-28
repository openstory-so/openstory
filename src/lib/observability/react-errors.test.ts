import { OpenStoryError } from '@/lib/errors';
import { describe, expect, it, vi } from 'vitest';

const captureException = vi.fn();
const posthog = { __loaded: false, captureException };
vi.doMock('posthog-js', () => ({ default: posthog }));

const { captureRouteError, flushReactErrors } = await import('./react-errors');

describe('captureRouteError', () => {
  it('queues before PostHog loads, flushes once it has, then captures directly', () => {
    const error = new Error('insertBefore');
    captureRouteError(error, { componentStack: '\n at Composer' });
    expect(captureException).not.toHaveBeenCalled();

    posthog.__loaded = true;
    flushReactErrors();
    expect(captureException).toHaveBeenCalledWith(error, {
      component_stack: '\n at Composer',
      page_translated: false,
    });

    captureRouteError(new Error('again'), {});
    expect(captureException).toHaveBeenCalledTimes(2);
    flushReactErrors();
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('skips 404s', () => {
    captureException.mockClear();
    posthog.__loaded = true;
    captureRouteError(new OpenStoryError('gone', 'NOT_FOUND', 404), {});
    expect(captureException).not.toHaveBeenCalled();
  });
});
