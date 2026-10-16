import type { Meta, StoryObj } from '@storybook/react';
import { Card, CardContent } from '@/ui/shadcn/card';
import { DivergentAlternateBanner } from './divergent-alternate-banner';
import { StalenessIndicator } from './staleness-indicator';

const meta: Meta<typeof DivergentAlternateBanner> = {
  title: 'UI/DivergentAlternateBanner',
  component: DivergentAlternateBanner,
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    onCompare: { action: 'compare' },
    onPromote: { action: 'promote' },
    onDiscard: { action: 'discard' },
    artifact: {
      control: 'select',
      options: [
        'thumbnail',
        'video',
        'audio',
        'sheet',
        'visual-prompt',
        'motion-prompt',
        'music-prompt',
      ],
    },
    entityType: {
      control: 'select',
      options: ['shot', 'character', 'location', 'talent', 'sequence'],
    },
    density: {
      control: 'radio',
      options: ['inline', 'corner-dot'],
    },
  },
  args: {
    variantId: 'variant_01HZK7P3X8Q2J4',
    artifact: 'thumbnail',
    entityType: 'shot',
  },
};

export default meta;
type Story = StoryObj<typeof DivergentAlternateBanner>;

export const DivergentWithAlternateInline: Story = {
  args: {
    density: 'inline',
    artifact: 'thumbnail',
    entityType: 'shot',
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

export const DivergentWithAlternateInlineVideo: Story = {
  args: {
    density: 'inline',
    artifact: 'video',
    entityType: 'shot',
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

export const DivergentWithAlternateCornerDot: Story = {
  args: {
    density: 'corner-dot',
    artifact: 'thumbnail',
    entityType: 'shot',
  },
  render: (args) => (
    <Card className="relative w-72">
      <div className="absolute right-3 top-3 z-10">
        <DivergentAlternateBanner {...args} />
      </div>
      <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        Scene card content
      </CardContent>
    </Card>
  ),
};

/**
 * When both states apply (live primary is stale AND a divergent alternate
 * exists), the divergent banner takes precedence and the staleness
 * indicator is suppressed — promoting the alternate resolves both states.
 */
export const BothStatesCoexisting: Story = {
  render: () => {
    const isStale = true;
    const hasDivergentAlternate = true;
    return (
      <div className="flex max-w-xl flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Both stale and divergent: only the divergent banner renders.
        </p>
        {/* Story mirrors production precedence: divergent wins when both apply. */}
        {/* oxlint-disable typescript/no-unnecessary-condition */}
        {hasDivergentAlternate ? (
          <DivergentAlternateBanner
            variantId="variant_01HZK7P3X8Q2J4"
            artifact="thumbnail"
            entityType="shot"
            onCompare={() => {}}
            onPromote={() => {}}
            onDiscard={() => {}}
          />
        ) : isStale ? (
          <StalenessIndicator
            artifact="thumbnail"
            entityType="shot"
            onRegenerate={() => {}}
          />
        ) : null}
        {/* oxlint-enable typescript/no-unnecessary-condition */}
      </div>
    );
  },
};
