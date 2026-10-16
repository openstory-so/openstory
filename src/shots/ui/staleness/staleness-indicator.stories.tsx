import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Card, CardContent } from '@/ui/shadcn/card';
import { StalenessIndicator } from './staleness-indicator';

const meta: Meta<typeof StalenessIndicator> = {
  title: 'UI/StalenessIndicator',
  component: StalenessIndicator,
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    onRegenerate: { action: 'regenerate' },
    onDismiss: { action: 'dismiss' },
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
      options: ['inline', 'corner-dot', 'status-line', 'header-chip'],
    },
  },
  args: {
    artifact: 'thumbnail',
    entityType: 'shot',
  },
};

export default meta;
type Story = StoryObj<typeof StalenessIndicator>;

/**
 * Non-stale: when the artifact is current, the parent doesn't render the
 * indicator at all — there's no "off" prop on the primitive itself.
 */
export const NonStale: Story = {
  render: () => {
    const isStale = false;
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          When inputs match, parent skips the indicator entirely.
        </p>
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {/* Story branch mirrors production gating — kept even though `isStale` is a fixed literal here. */}
          {/* oxlint-disable-next-line typescript/no-unnecessary-condition */}
          {isStale ? (
            <StalenessIndicator
              artifact="thumbnail"
              entityType="shot"
              onRegenerate={() => {}}
            />
          ) : (
            <span>(no indicator rendered)</span>
          )}
        </div>
      </div>
    );
  },
};

export const StaleInline: Story = {
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

export const StaleInlineDismissible: Story = {
  args: {
    density: 'inline',
    artifact: 'video',
    entityType: 'shot',
    onDismiss: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

export const StaleCornerDot: Story = {
  args: {
    density: 'corner-dot',
    artifact: 'thumbnail',
    entityType: 'shot',
  },
  render: (args) => (
    <Card className="relative w-72">
      <div className="absolute right-3 top-3 z-10">
        <StalenessIndicator {...args} />
      </div>
      <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        Scene card content
      </CardContent>
    </Card>
  ),
};

/**
 * Quiet one-line summary (#1077) — sits under the panel's scope header.
 * Amber dot only; no fill, no triangle.
 */
export const StaleStatusLine: Story = {
  args: {
    density: 'status-line',
    entityType: 'shot',
    onRegenerate: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

/** The comparison itself failed — muted dot, no amber, no action. */
export const StalenessUnknown: Story = {
  args: {
    density: 'status-line',
    entityType: 'shot',
    tone: 'unknown',
    message: 'Couldn’t check whether this shot is up to date',
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

/** Header-row chip (#1077) — `⏺ Outdated · Regenerate` beside a field label. */
export const StaleHeaderChip: Story = {
  args: {
    density: 'header-chip',
    artifact: 'visual-prompt',
    entityType: 'shot',
    onRegenerate: () => {},
  },
  render: (args) => (
    <div className="flex max-w-xl items-center justify-between">
      <span className="flex items-center gap-2">
        <span className="text-sm font-medium">Prompt</span>
        <StalenessIndicator {...args} />
      </span>
      <span className="text-xs text-muted-foreground">1234 characters</span>
    </div>
  ),
};

const SoftDismissDemo: React.FC = () => {
  const [count, setCount] = useState(0);
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <StalenessIndicator
        artifact="thumbnail"
        entityType="shot"
        onRegenerate={() => setCount((c) => c + 1)}
        onDismiss={() => {}}
      />
      <p className="text-xs text-muted-foreground">
        Regenerate clicks: {count}
      </p>
    </div>
  );
};

/**
 * Demonstrates internal session-scoped soft-dismiss.
 * Click the X — the indicator disappears for this session.
 */
export const SoftDismissBehavior: Story = {
  render: () => <SoftDismissDemo />,
};
