import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { micros } from '@/lib/billing/money';
import { type GenerationStage } from '@/lib/generation/pipeline';
import { GenerationStopAlert } from './generation-stop-alert';

const COST_BY_STAGE: Record<GenerationStage, ReturnType<typeof micros>> = {
  script: micros(8_000),
  references: micros(420_000),
  images: micros(1_200_000),
  motion: micros(2_100_000),
  music: micros(2_400_000),
};

function OpenAlert() {
  const [open, setOpen] = useState(true);
  return (
    <GenerationStopAlert
      open={open}
      onOpenChange={setOpen}
      stopAt="music"
      remember={false}
      estimateForStopAt={(stage) => COST_BY_STAGE[stage]}
      onConfirm={() => setOpen(false)}
    />
  );
}

const meta: Meta<typeof GenerationStopAlert> = {
  title: 'Generation/GenerationStopAlert',
  component: GenerationStopAlert,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof GenerationStopAlert>;

export const Default: Story = {
  render: () => <OpenAlert />,
};
