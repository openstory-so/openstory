import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { GenerationStopSlider } from './generation-stop-slider';
import type { GenerationStage } from '@/shared/generation/pipeline';

function StatefulSlider(
  props: Omit<ComponentProps<typeof GenerationStopSlider>, 'onChange'>
) {
  const [value, setValue] = useState<GenerationStage>(props.value);
  return <GenerationStopSlider {...props} value={value} onChange={setValue} />;
}

const meta: Meta<typeof GenerationStopSlider> = {
  title: 'Generation/GenerationStopSlider',
  component: GenerationStopSlider,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof GenerationStopSlider>;

export const DialogWidth: Story = {
  name: 'Generate dialog (~32rem)',
  render: () => (
    <div className="mx-auto w-full max-w-lg rounded-lg border p-6">
      <StatefulSlider value="music" />
    </div>
  ),
};

export const StopAtReferences: Story = {
  name: 'Stop at References',
  render: () => (
    <div className="mx-auto w-full max-w-lg rounded-lg border p-6">
      <StatefulSlider value="references" />
    </div>
  ),
};

export const SceneListWidth: Story = {
  name: 'Scene-list footer (280px)',
  render: () => (
    <div className="w-[280px] rounded-lg border p-4">
      <StatefulSlider value="images" minStage="images" />
    </div>
  ),
};

export const ContinueFromImages: Story = {
  name: 'Continue from Images (360px)',
  render: () => (
    <div className="w-[360px] rounded-lg border p-4">
      <StatefulSlider value="images" minStage="images" />
    </div>
  ),
};
