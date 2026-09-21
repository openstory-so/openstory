import type { Meta, StoryObj } from '@storybook/react';
import { SequencePlayer } from './sequence-player';
import type { SceneInput } from './concatenated-video-source';
import videoUrl from '../../../../e2e/fixtures/test-video.mp4?url';

// A PCM WAV like the dialogue section files; no provider URLs or live calls.
function dialogueFixture() {
  const bytes = new Uint8Array(44 + 32000);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) =>
    value.split('').forEach((char, index) => {
      bytes[offset + index] = char.charCodeAt(0);
    });
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, 32000, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}
const still: SceneInput = {
  orderIndex: 0,
  imageUrl: '/icon-512.png',
  fallbackImageUrl: null,
  durationSeconds: 5,
  audioUrls: [],
  width: 1280,
  height: 720,
};
const meta = {
  title: 'Sequences/Sequence Player',
  component: SequencePlayer,
  args: {
    scenes: [still],
    aspectRatio: '16:9',
    musicUrl: null,
    musicLoudnessGainDb: null,
    musicEnabled: false,
    onMusicEnabledChange: () => {},
    cachedVideoUrl: null,
  },
  render: function PlayerStory(args) {
    return (
      <div className="max-w-3xl">
        <SequencePlayer {...args} />
      </div>
    );
  },
} satisfies Meta<typeof SequencePlayer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Still: Story = {};
export const Mixed: Story = {
  args: {
    scenes: [
      still,
      { orderIndex: 1, videoUrl },
      {
        ...still,
        orderIndex: 2,
        durationSeconds: 7,
        audioUrls: [dialogueFixture()],
      },
    ],
  },
};
export const MissingImages: Story = {
  args: {
    scenes: [
      {
        ...still,
        imageUrl: '/missing.png',
        fallbackImageUrl: '/also-missing.png',
      },
    ],
  },
};
export const CachedExportWithMissingVideo: Story = {
  args: { cachedVideoUrl: videoUrl },
};
