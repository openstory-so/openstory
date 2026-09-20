import { VIDEO_MODEL_VOICE_TOKEN } from '@/motion/dialogue-tts';
import type { SequenceElementMinimal } from '@/platform/server/db/schema';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  MotionDialoguePanel,
  ShotDialogueBlock,
  ShotDialogueHistory,
  ShotReadingsList,
  type ShotDialogueReading,
} from './motion-dialogue-panel';

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

const AUDIO_URL =
  'https://www.w3.org/WAI/content-assets/wcag-act-rules/test-assets/moon-audio.mp3';

const reading = (
  id: string,
  over: Partial<ShotDialogueReading>
): ShotDialogueReading => ({
  id,
  source: 'recorded',
  selected: false,
  fromSeconds: 0,
  toSeconds: 2.4,
  recordingUrl: AUDIO_URL,
  createdAt: '2026-09-18T10:00:00Z',
  matchesCurrentLines: true,
  ...over,
});

const current = reading('r-3', {
  selected: true,
  createdAt: '2026-09-20T09:30:00Z',
});
const severalReadings = [
  current,
  reading('r-2', {
    source: 'context',
    fromSeconds: 3.1,
    toSeconds: 5.8,
    createdAt: '2026-09-19T16:12:00Z',
  }),
  reading('r-1', { matchesCurrentLines: false }),
];

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

export const WithReadings: Story = {
  args: {
    readings: (
      <ShotReadingsList
        readings={severalReadings}
        onUse={fn()}
        onDiscard={fn()}
      />
    ),
  },
};

// The read-only block under the shot's video (#1657).
const clip = { url: AUDIO_URL, durationSeconds: 2.4 };

export const BlockNoDialogue: Story = {
  render: () => (
    <ShotDialogueBlock
      dialogue={{ presence: false, lines: [] }}
      elements={[]}
    />
  ),
};

export const BlockLinesNoAudioYet: Story = {
  render: () => (
    <ShotDialogueBlock
      dialogue={dialogue}
      elements={[]}
      readings={
        <ShotReadingsList
          readings={[]}
          onUse={fn()}
          onDiscard={fn()}
          collapsible
        />
      }
    />
  ),
};

export const BlockCurrentReadingOnly: Story = {
  render: () => (
    <ShotDialogueBlock
      dialogue={dialogue}
      elements={[]}
      clip={clip}
      readings={
        <ShotReadingsList
          readings={[current]}
          onUse={fn()}
          onDiscard={fn()}
          collapsible
        />
      }
    />
  ),
};

export const BlockSeveralReadings: Story = {
  render: () => (
    <ShotDialogueBlock
      dialogue={dialogue}
      elements={[]}
      clip={clip}
      readings={
        <ShotReadingsList
          readings={severalReadings}
          onUse={fn()}
          onDiscard={fn()}
          collapsible
        />
      }
    />
  ),
};

/** Two sets of lines: the script's, then an edit. "Use" goes back. */
export const History: Story = {
  render: () => (
    <ShotDialogueHistory
      versions={[
        {
          id: 'v2',
          source: 'user-edit',
          createdAt: '2026-09-20T10:05:00Z',
          selected: true,
          lines: [{ character: 'SARAH', line: 'This deadline will kill me.' }],
        },
        {
          id: 'v1',
          source: 'prompt',
          createdAt: '2026-09-20T09:00:00Z',
          selected: false,
          lines: dialogue.lines,
        },
      ]}
      onUse={fn()}
    />
  ),
};
