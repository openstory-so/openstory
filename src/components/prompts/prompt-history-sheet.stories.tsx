import type { Meta, StoryObj } from '@storybook/react';
import { Button } from '@/components/ui/button';
import { useState } from 'react';
import { PromptHistorySheet } from './prompt-history-sheet';

const meta: Meta<typeof PromptHistorySheet> = {
  title: 'Prompts/PromptHistorySheet',
  component: PromptHistorySheet,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof PromptHistorySheet>;

const Demo: React.FC<{ mode: 'visual' | 'motion' | 'music' }> = ({ mode }) => {
  const [open, setOpen] = useState(true);
  return (
    <div className="p-8">
      <Button type="button" onClick={() => setOpen(true)}>
        Open history
      </Button>
      {mode === 'music' ? (
        <PromptHistorySheet
          open={open}
          onOpenChange={setOpen}
          mode="music"
          sequenceId="seq-1"
          currentText="Slow brooding cello, sparse percussion, building tension."
        />
      ) : (
        <PromptHistorySheet
          open={open}
          onOpenChange={setOpen}
          mode={mode}
          sequenceId="seq-1"
          shotId="shot-1"
          currentText="Wide cinematic shot of a coffee shop, warm sunlight, steam rising."
        />
      )}
    </div>
  );
};

export const VisualPrompt: Story = {
  render: () => <Demo mode="visual" />,
};

export const MotionPrompt: Story = {
  render: () => <Demo mode="motion" />,
};

export const MusicPrompt: Story = {
  render: () => <Demo mode="music" />,
};
