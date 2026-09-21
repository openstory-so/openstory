import type { Meta, StoryObj } from '@storybook/react';
import { dbSceneId } from '@/shots/scene-id';
import { AnimaticDialog } from './animatic-player';
import type { AnimaticShot } from './animatic-shots';

const still = (label: string) =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#273444"/><text x="320" y="180" text-anchor="middle" fill="white" font-size="32">${label}</text></svg>`)}`;
// A local one-second WAV keeps the story independent of expiring media URLs.
function silence() {
  const bytes = new Uint8Array(44 + 16000);
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
  view.setUint32(40, 16000, true);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}
const shots = [
  {
    id: 'one',
    sceneId: dbSceneId('scene-a'),
    shotNumber: 1,
    durationMs: 5000,
    previewThumbnailUrl: still('Storyboard preview'),
    image: { url: still('Thumbnail') },
    dialogue: {
      presence: true,
      lines: [{ character: 'Ana', line: 'A longer authored line', tone: '' }],
    },
    audioClips: [
      {
        id: 'reading',
        url: silence(),
        token: 'DIALOGUE',
        durationSeconds: 1,
        spokenLines: [{ index: 0, text: 'The recorded wording.' }],
      },
    ],
  },
  {
    id: 'two',
    sceneId: dbSceneId('scene-a'),
    shotNumber: 2,
    durationMs: 3000,
    previewThumbnailUrl: null,
    image: { url: still('Silent shot thumbnail') },
    dialogue: null,
    audioClips: [],
  },
  {
    id: 'three',
    sceneId: dbSceneId('scene-b'),
    shotNumber: 1,
    durationMs: 2000,
    previewThumbnailUrl: null,
    image: null,
    dialogue: null,
    audioClips: [],
  },
] satisfies [AnimaticShot, ...AnimaticShot[]];
const meta = {
  title: 'Sequences/Animatic',
  component: AnimaticDialog,
  args: {
    shots,
    scenes: [{ id: 'scene-a' }, { id: 'scene-b' }],
    selection: { sceneIds: ['scene-a'] },
    aspectRatio: '16:9',
  },
} satisfies Meta<typeof AnimaticDialog>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Scene: Story = {};
export const WholeSequence: Story = { args: { selection: { sceneIds: [] } } };
export const Portrait: Story = { args: { aspectRatio: '9:16' } };
export const MissingMedia: Story = {
  args: {
    shots: [
      {
        ...shots[0],
        previewThumbnailUrl: '/missing-preview.png',
        image: { url: still('Fallback thumbnail') },
        audioClips: [
          {
            id: 'missing',
            token: 'DIALOGUE',
            url: '/missing-dialogue.wav',
            durationSeconds: 1,
          },
        ],
      },
      ...shots.slice(1),
    ],
  },
};
