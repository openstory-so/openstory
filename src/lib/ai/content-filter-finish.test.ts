/**
 * Regression tests for #1304 — an Anthropic content-filter stop on the
 * ANALYSIS call surfaced as an opaque `structured-output-missing-result` /
 * `Failed to parse structured output as JSON`, was retried five times, and
 * reached the user as "frame-prompt child(ren) returned no body for scene(s)
 * [01M0…]".
 *
 * Verified against prod: OpenRouter returns `finish_reason: 'content_filter'`
 * with zero content for the failing scene, on Anthropic-direct AND on
 * AWS-hosted Claude (so it is the model's classifier, not the #1302 routing
 * pin).
 */
import { describe, expect, it } from 'vitest';
import {
  contentFilterLlmMessage,
  contentRejectionSummary,
  isContentFilterFinish,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';

describe('isContentFilterFinish', () => {
  it('detects a RUN_FINISHED that stopped on the safety classifier', () => {
    expect(
      isContentFilterFinish({
        type: 'RUN_FINISHED',
        finishReason: 'content_filter',
      })
    ).toBe(true);
  });

  it('ignores a normal completion', () => {
    expect(
      isContentFilterFinish({ type: 'RUN_FINISHED', finishReason: 'stop' })
    ).toBe(false);
  });

  it('ignores a truncation, which IS worth retrying', () => {
    expect(
      isContentFilterFinish({ type: 'RUN_FINISHED', finishReason: 'length' })
    ).toBe(false);
  });

  it('ignores other events and malformed provider shots', () => {
    expect(isContentFilterFinish({ type: 'RUN_ERROR', code: 'refusal' })).toBe(
      false
    );
    expect(
      isContentFilterFinish({ type: 'RUN_FINISHED', finishReason: 42 })
    ).toBe(false);
    expect(isContentFilterFinish({ type: 'RUN_FINISHED' })).toBe(false);
    expect(isContentFilterFinish(null)).toBe(false);
    expect(isContentFilterFinish('RUN_FINISHED')).toBe(false);
  });
});

describe('contentFilterLlmMessage', () => {
  it('classifies as a content rejection so the UI treats it as a warning', () => {
    const message = contentFilterLlmMessage('Scene 3');
    // The severity/banner logic keys off this predicate; if it returns false
    // the user gets a red "Generation failed" with no cause again.
    expect(isContentRejectionError(message)).toBe(true);
  });

  it('names the blocked scene', () => {
    expect(contentFilterLlmMessage('Scene 3')).toContain('Scene 3');
  });
});

describe('batch aggregation', () => {
  it('summarises an all-content-filter batch by scene, not by opaque id', () => {
    const failures = [
      { name: 'Scene 3', reason: contentFilterLlmMessage('Scene 3') },
      { name: 'Scene 2', reason: contentFilterLlmMessage('Scene 2') },
    ];
    const summary = contentRejectionSummary(failures);
    expect(summary).toBe('Blocked by the content checker: Scene 3, Scene 2');
  });

  it('keeps the diagnostic message when any failure was NOT a content filter', () => {
    const failures = [
      { name: 'Scene 3', reason: contentFilterLlmMessage('Scene 3') },
      { name: 'Scene 4', reason: 'Network connection lost.' },
    ];
    expect(contentRejectionSummary(failures)).toBeNull();
  });
});
