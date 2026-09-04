import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { OptimisedPromptPanel } from './optimised-prompt-panel';

const meta: Meta<typeof OptimisedPromptPanel> = {
  title: 'Scenes/OptimisedPromptPanel',
  component: OptimisedPromptPanel,
  parameters: { layout: 'centered' },
  args: {
    copiedKey: null,
    onCopy: fn(),
    idPrefix: 'image-request',
  },
  decorators: [
    (Story) => (
      <div className="w-[420px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof OptimisedPromptPanel>;

export const Collapsed: Story = {
  args: {
    preview: {
      modelName: 'GPT Image 2',
      endpointId: 'openai/gpt-image-2',
      prompt: 'Wide shot of Sarah at a sunlit coffee shop, typing furiously.',
      json: JSON.stringify(
        {
          prompt:
            'Wide shot of Sarah at a sunlit coffee shop, typing furiously.',
          image_size: 'landscape_16_9',
        },
        null,
        2
      ),
      promptLength: 64,
      maxPromptLength: 32000,
    },
  },
};

export const OverLimit: Story = {
  args: {
    preview: {
      modelName: 'FLUX.2 Max',
      endpointId: 'fal-ai/flux-2-max',
      prompt: 'A very long assembled prompt that exceeds the model cap.',
      json: JSON.stringify({ prompt: 'truncated…' }, null, 2),
      promptLength: 2480,
      maxPromptLength: 2000,
    },
  },
};

export const BoundImages: Story = {
  args: {
    defaultOpen: true,
    preview: {
      modelName: 'Seedance 2.5',
      endpointId: 'dreamina-seedance-2-5-260628',
      prompt:
        'Use @Image1 as the starting frame.\n@Image2 turns toward the window.',
      json: JSON.stringify(
        {
          prompt: 'Use @Image1 as the starting frame.',
          image_urls: [
            'https://picsum.photos/seed/still/256/256',
            'https://picsum.photos/seed/cast/256/256',
          ],
        },
        null,
        2
      ),
      promptLength: 64,
      maxPromptLength: 4096,
      images: [
        {
          label: '@Image1',
          url: 'https://picsum.photos/seed/still/256/256',
        },
        {
          label: '@Image2',
          url: 'https://picsum.photos/seed/cast/256/256',
        },
      ],
    },
  },
};

export const AssembledTextOnly: Story = {
  args: {
    preview: {
      modelName: 'Seedance 2.0',
      endpointId: 'bytedance/seedance-2.0/enterprise/v2/image-to-video',
      prompt:
        'Slow push in as Sarah types.\n\nDialogue: SARAH: "This deadline is going to kill me."',
      json: null,
      promptLength: 92,
      maxPromptLength: 4096,
    },
  },
};
