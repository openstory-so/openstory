import { CREDITS_SHORT_TITLE } from '@/lib/billing/credits-short';
import type { FailureSummary } from '@/lib/failures/failure-analysis';
import type { Meta, StoryObj } from '@storybook/react';
import { FailureSummaryBanner } from './failure-summary-banner';

const meta: Meta<typeof FailureSummaryBanner> = {
  title: 'Sequence/FailureSummaryBanner',
  component: FailureSummaryBanner,
  parameters: {
    layout: 'padded',
  },
  args: {
    onRetry: () => undefined,
    isRetrying: false,
  },
};

export default meta;
type Story = StoryObj<typeof FailureSummaryBanner>;

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

const failedSummary: FailureSummary = {
  requiresFullRetry: true,
  headline: 'Generation failed \u2014 full retry required',
  groups: [],
  totalFailures: 1,
  hasFailed: true,
  error:
    'Child workflow scene-split failed: Failed query: delete from "scenes"',
  tone: 'error',
};

export const CreditsShort: Story = {
  name: 'Out of credits (#1328)',
  args: { summary: creditsSummary },
};

export const ContentChecker: Story = {
  args: { summary: contentSummary },
};

export const GenerationFailed: Story = {
  args: { summary: failedSummary },
};
