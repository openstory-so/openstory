import type { Meta, StoryObj } from '@storybook/react';
import { SequenceListStatus } from './eval-sequence-metadata';

const meta: Meta<typeof SequenceListStatus> = {
  title: 'Sequence/SequenceListStatus',
  component: SequenceListStatus,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof SequenceListStatus>;

export const CreditsShort: Story = {
  name: 'Out of credits (#1328)',
  args: {
    sequence: {
      status: 'failed',
      statusError:
        'Not enough credits to generate images for 11 scenes. Add $4.20 more, then continue.',
      musicError: null,
      shots: [],
    },
  },
};

export const GenerationFailed: Story = {
  args: {
    sequence: {
      status: 'failed',
      statusError: 'Child workflow scene-split failed',
      musicError: null,
      shots: [],
    },
  },
};
