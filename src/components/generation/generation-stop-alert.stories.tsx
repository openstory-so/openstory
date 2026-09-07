import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { GenerationStopAlert } from './generation-stop-alert';

function OpenAlert() {
  const [open, setOpen] = useState(true);
  return (
    <GenerationStopAlert
      open={open}
      onOpenChange={setOpen}
      stopAt="music"
      generateStartFrames={false}
      remember={false}
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
