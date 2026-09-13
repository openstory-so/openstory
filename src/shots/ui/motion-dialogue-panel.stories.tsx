import { VIDEO_MODEL_VOICE_TOKEN } from '@/motion/dialogue-tts';
import type { SequenceElementMinimal } from '@/platform/server/db/schema';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { MotionDialoguePanel } from './motion-dialogue-panel';

const dialogue = {
  presence: true as const,
  lines: [
    {
      character: 'SARAH',
      line: 'This deadline is going to kill me.',
      tone: 'tense',
    },
    { character: 'AL', line: 'Breathe.', tone: '' },
  ],
};

const voice: SequenceElementMinimal = {
  id: 'el-1',
  token: 'SARAH_VOICE',
  description: null,
  imageUrl: '/r2/audio/sarah.wav',
  consistencyTag: 'sarah-voice',
  kind: 'audio',
  durationSeconds: 4.2,
};

const meta: Meta<typeof MotionDialoguePanel> = {
  title: 'Scenes/MotionDialoguePanel',
  component: MotionDialoguePanel,
  args: {
    dialogue,
    elements: [voice],
    onChange: fn(),
    source: 'prompt',
    clip: {
      url: 'https://www.w3.org/WAI/content-assets/wcag-act-rules/test-assets/moon-audio.mp3',
      durationSeconds: 2.4,
    },
  },
};

export default meta;
type Story = StoryObj<typeof MotionDialoguePanel>;

export const GeneratedTake: Story = {};

export const NoClipYet: Story = {
  args: { clip: null },
};

export const ScriptStage: Story = {
  args: { onChange: null, source: 'script' },
};

export const VideoModel: Story = {
  args: {
    clip: null,
    dialogue: {
      presence: true,
      lines: dialogue.lines.map((line) => ({
        ...line,
        voiceToken: VIDEO_MODEL_VOICE_TOKEN,
      })),
    },
  },
};

export const DialogueExceedsShot: Story = {
  args: {
    shotSeconds: 4,
    clip: {
      url: 'https://www.w3.org/WAI/content-assets/wcag-act-rules/test-assets/moon-audio.mp3',
      durationSeconds: 6.2,
    },
  },
};
