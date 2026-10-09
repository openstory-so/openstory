import { useState, type ComponentProps } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { GenerationStopSlider } from './generation-stop-slider';
import type { GenerationStage } from '@/sequences/pipeline';

function StatefulSlider(
  props: Omit<
    ComponentProps<typeof GenerationStopSlider>,
    'onChange' | 'generateStartFrames' | 'onGenerateStartFramesChange'
  > & {
    generateStartFrames?: boolean;
  }
) {
  const { generateStartFrames: initialStartFrames, ...rest } = props;
  const [value, setValue] = useState<GenerationStage>(props.value);
  const [startFrames, setStartFrames] = useState(initialStartFrames ?? true);
  return (
    <GenerationStopSlider
      {...rest}
      value={value}
      onChange={setValue}
      generateStartFrames={startFrames}
      onGenerateStartFramesChange={setStartFrames}
    />
  );
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
      <StatefulSlider value="music" generateStartFrames={false} />
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
      <StatefulSlider value="images" minStage="images" generateStartFrames />
    </div>
  ),
};

export const CombinedImagesAndDialogue: Story = {
  name: 'Start Frames & Dialogue — one stop',
  render: () => (
    <div className="w-[360px] rounded-lg border p-4">
      <StatefulSlider
        value="dialogue"
        minStage="references"
        generateStartFrames
        generateVoices
      />
    </div>
  ),
};

export const ContinueFromReferences: Story = {
  name: 'Continue from References — both switches',
  render: () => (
    <div className="w-[360px] rounded-lg border p-4">
      <StatefulSlider
        value="references"
        minStage="references"
        generateStartFrames={false}
      />
    </div>
  ),
};

export const ContinueFromDialogue: Story = {
  name: 'Continue from Dialogue — no switches',
  render: () => (
    <div className="w-[360px] rounded-lg border p-4">
      <StatefulSlider
        value="dialogue"
        minStage="dialogue"
        generateStartFrames
        generateVoices
      />
    </div>
  ),
};

export const DraftFirst: Story = {
  name: 'Draft first (six ticks, alternating labels)',
  render: () => (
    <div className="mx-auto w-full max-w-lg rounded-lg border p-6">
      <DraftFirstSlider />
    </div>
  ),
};

function DraftFirstSlider() {
  const [value, setValue] = useState<GenerationStage>('music');
  const [startFrames, setStartFrames] = useState(true);
  const [draftFirst, setDraftFirst] = useState(true);
  return (
    <GenerationStopSlider
      value={value}
      onChange={setValue}
      generateStartFrames={startFrames}
      onGenerateStartFramesChange={setStartFrames}
      generateVoices
      draftFirst={draftFirst}
      onDraftFirstChange={setDraftFirst}
    />
  );
}
