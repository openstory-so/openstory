import { CONTENT_REJECTION_USER_HINT } from '@/lib/ai/content-rejection';
import { CREDITS_SHORT_TITLE } from '@/lib/billing/credits-short';
import type { FailureSummary } from '@/lib/failures/failure-analysis';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FailureSummaryBanner } from './failure-summary-banner';

const contentSummary: FailureSummary = {
  requiresFullRetry: true,
  headline:
    "Harry Potter didn't pass the content checker \u2014 regenerate to retry",
  groups: [],
  totalFailures: 1,
  hasFailed: true,
  error: 'Blocked by the content checker: Harry Potter',
  tone: 'warning',
};

const creditsSummary: FailureSummary = {
  requiresFullRetry: true,
  headline: CREDITS_SHORT_TITLE,
  groups: [],
  totalFailures: 1,
  hasFailed: true,
  error:
    'Not enough credits to generate images for 11 scenes. Add $4.20 more, then continue.',
  tone: 'credits',
};

const generationFailed: FailureSummary = {
  requiresFullRetry: true,
  headline: 'Generation failed — regenerate to retry',
  groups: [],
  totalFailures: 1,
  hasFailed: true,
  error: 'Workflow timed out while generating scene prompts',
  tone: 'error',
};

describe('FailureSummaryBanner', () => {
  it('SSRs the content-checker title instead of Generation failed', () => {
    const html = renderToStaticMarkup(
      <FailureSummaryBanner
        summary={contentSummary}
        onRetry={() => undefined}
        isRetrying={false}
      />
    );

    expect(html).toContain('Content checker');
    expect(html).toContain('pass the content checker');
    expect(html).toContain('regenerate to retry');
    expect(html).toContain(CONTENT_REJECTION_USER_HINT);
    expect(html).not.toContain('Generation failed');
  });

  it('SSRs a top-up prompt instead of Generation failed (#1328)', () => {
    const html = renderToStaticMarkup(
      <FailureSummaryBanner
        summary={creditsSummary}
        onRetry={() => undefined}
        isRetrying={false}
      />
    );

    expect(html).toContain(CREDITS_SHORT_TITLE);
    expect(html).toContain('This sequence has 11 scenes');
    expect(html).toContain('Add $4.20 more');
    expect(html).toContain('Add credits');
    expect(html).toContain('Continue generation');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('Generation failed');
    expect(html).not.toContain('full retry required');
    expect(html).not.toContain('Regenerate Sequence');
    expect(html).not.toContain('text-destructive');
    expect(html).not.toContain('font-mono');
  });

  it('SSRs error-tone retry while mobile starts collapsed', () => {
    const html = renderToStaticMarkup(
      <FailureSummaryBanner
        summary={generationFailed}
        onRetry={() => undefined}
        onFullRetry={() => undefined}
        isRetrying={false}
      />
    );

    expect(html).toContain('Generation failed');
    expect(html).toContain('Workflow timed out');
    expect(html).toContain('Regenerate Sequence');
    expect(html).toContain('Show details');
    expect(html).toContain('aria-expanded="false"');
  });
});
