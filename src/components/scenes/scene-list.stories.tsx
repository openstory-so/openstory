import { generateMockShots } from '@/lib/mocks/data-generators';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import { dbSceneId, type DbSceneId } from '@/lib/db/schema';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type {
  SegmentVideoVersion,
  SequenceSegment,
} from '@/lib/scenes/scene-segments';
import type { ShotView } from '@/lib/shots/shot-view';
import type { Meta, StoryObj } from '@storybook/react';
import { SceneList } from './scene-list';

const mockShots = generateMockShots(5, 'mock-sequence-id');

// ---------------------------------------------------------------------------
// Per-segment video demo (#986): 3 scenes, 9 shots, 4 render segments.
//   Scene 1 (5 shots): shots 1–3 = one video, shots 4–5 = another (same model —
//                      video model is a scene-level choice).
//   Scene 2 (3 shots): all one video.
//   Scene 3 (1 shot):  still bracketed, so its model shows even for one shot.
// Every rendered segment is bracketed with its video model; the shot count only
// shows when a video spans >1 shot, and a Stale badge appears when a covered
// shot's inputs changed after the render (segment 1b here). The scene header
// itself carries no model — the model lives on the segment.
// Assets are the permanent recorded e2e fal.media stills.
// ---------------------------------------------------------------------------
const PS_SEQ = 'seq-per-segment';
const PS_SCENE_1: DbSceneId = dbSceneId('scene-1');
const PS_SCENE_2: DbSceneId = dbSceneId('scene-2');
const PS_SCENE_3: DbSceneId = dbSceneId('scene-3');
const PS_VIDEO_URL =
  'https://v3b.fal.media/files/b/0aa07d1a/_P-KU4ZFn_QECjTauF5Zt_video.mp4';
const PS_FIXED_DATE = new Date('2026-07-18T00:00:00Z');

type PsShotConfig = {
  sceneId: DbSceneId;
  shotNumber: number;
  segmentId: string;
  img: string;
};

const PS_SHOT_CONFIGS: PsShotConfig[] = [
  {
    sceneId: PS_SCENE_1,
    shotNumber: 1,
    segmentId: 'seg-1a',
    img: 'https://v3b.fal.media/files/b/0aa07ce2/iFBVdtquvFO-l2vGJRVsC_mNFiZslo.png',
  },
  {
    sceneId: PS_SCENE_1,
    shotNumber: 2,
    segmentId: 'seg-1a',
    img: 'https://v3b.fal.media/files/b/0aa07ce4/HgxEwVHNrUixbm-_dR8bc_2Bacz9wg.png',
  },
  {
    sceneId: PS_SCENE_1,
    shotNumber: 3,
    segmentId: 'seg-1a',
    img: 'https://v3b.fal.media/files/b/0aa07ce4/iLS11FJRxRr8H_Iw9_H_O_1csN9Umz.png',
  },
  {
    sceneId: PS_SCENE_1,
    shotNumber: 4,
    segmentId: 'seg-1b',
    img: 'https://v3b.fal.media/files/b/0aa07ce5/_HAebb2kDrh97bR2DL6vu_yBeNTZZJ.png',
  },
  {
    sceneId: PS_SCENE_1,
    shotNumber: 5,
    segmentId: 'seg-1b',
    img: 'https://v3b.fal.media/files/b/0aa07ce5/BwTrjcxVX-Fs1We1l4IBM_QaK1Bd1n.png',
  },
  {
    sceneId: PS_SCENE_2,
    shotNumber: 1,
    segmentId: 'seg-2',
    img: 'https://v3b.fal.media/files/b/0aa07ce6/NeohE6XI-Adf4a-6aDGGS_c85Jc7D1.png',
  },
  {
    sceneId: PS_SCENE_2,
    shotNumber: 2,
    segmentId: 'seg-2',
    img: 'https://v3b.fal.media/files/b/0aa07cee/bV9Wx1jvwg27xsfwiqUU5_5ZLNhv3V.png',
  },
  {
    sceneId: PS_SCENE_2,
    shotNumber: 3,
    segmentId: 'seg-2',
    img: 'https://v3b.fal.media/files/b/0aa07cee/S-dSgtIz6Coye0LHSs-Yc_thr2EVqB.png',
  },
  // Scene 3: a single shot — still bracketed so its video model shows.
  {
    sceneId: PS_SCENE_3,
    shotNumber: 1,
    segmentId: 'seg-3',
    img: 'https://v3b.fal.media/files/b/0aa07cee/Xv31Iyg2Rdhkum7LB70DK_3Ui384QL.png',
  },
];

const psBases = generateMockShots(PS_SHOT_CONFIGS.length, PS_SEQ);

const perSegmentShots: ShotView[] = PS_SHOT_CONFIGS.map((cfg, index) => {
  const base = psBases[index];
  if (!base) throw new Error(`missing mock shot base at ${index}`);
  const video = base.primaryVideo
    ? { ...base.primaryVideo, url: PS_VIDEO_URL, status: 'completed' as const }
    : null;
  return {
    ...base,
    id: `shot-${index}`,
    sequenceId: PS_SEQ,
    sceneId: cfg.sceneId,
    shotNumber: cfg.shotNumber,
    renderSegmentId: cfg.segmentId,
    frame: {
      ...base.frame,
      imageStatus: 'completed' as const,
      imageError: null,
    },
    image: base.image ? { ...base.image, url: cfg.img } : null,
    video,
    primaryVideo: video,
    videoStatus: 'completed' as const,
  };
});

const psVersion = (id: string, model: string): SegmentVideoVersion => ({
  id,
  model,
  status: 'completed',
  url: PS_VIDEO_URL,
  createdAt: PS_FIXED_DATE,
});

const perSegmentSegments: SequenceSegment[] = [
  {
    id: 'seg-1a',
    sceneId: PS_SCENE_1,
    shotIds: ['shot-0', 'shot-1', 'shot-2'],
    selectedVersionId: 'v-1a',
    selectedVersion: psVersion('v-1a', 'kling_v3_pro'),
    versions: [psVersion('v-1a', 'kling_v3_pro')],
    model: 'kling_v3_pro',
    stale: false,
  },
  {
    id: 'seg-1b',
    sceneId: PS_SCENE_1,
    shotIds: ['shot-3', 'shot-4'],
    selectedVersionId: 'v-1b',
    // Same model as seg-1a: video model is a scene-level choice, so a scene's
    // segments normally share it. This is the second video of the SAME scene.
    selectedVersion: psVersion('v-1b', 'kling_v3_pro'),
    versions: [
      psVersion('v-1b-old', 'kling_v3_pro'),
      psVersion('v-1b', 'kling_v3_pro'),
    ],
    model: 'kling_v3_pro',
    stale: true,
  },
  {
    id: 'seg-2',
    sceneId: PS_SCENE_2,
    shotIds: ['shot-5', 'shot-6', 'shot-7'],
    selectedVersionId: 'v-2',
    selectedVersion: psVersion('v-2', 'seedance_v2'),
    versions: [psVersion('v-2', 'seedance_v2')],
    model: 'seedance_v2',
    stale: false,
  },
  // Single-shot segment → still bracketed, so its model shows (a different
  // scene, so a different model is fine).
  {
    id: 'seg-3',
    sceneId: PS_SCENE_3,
    shotIds: ['shot-8'],
    selectedVersionId: 'v-3',
    selectedVersion: psVersion('v-3', 'veo3_1'),
    versions: [psVersion('v-3', 'veo3_1')],
    model: 'veo3_1',
    stale: false,
  },
];

const psScene = (
  id: DbSceneId,
  orderIndex: number,
  title: string,
  extract: string
): SceneWithScript => ({
  id,
  sequenceId: PS_SEQ,
  orderIndex,
  location: null,
  timeOfDay: null,
  storyBeat: null,
  title,
  continuity: null,
  script: { extract, dialogue: [] },
  selectedScriptVersionId: null,
  deletedAt: null,
  createdAt: PS_FIXED_DATE,
  updatedAt: PS_FIXED_DATE,
});

const perSegmentScenes: SceneWithScript[] = [
  psScene(
    PS_SCENE_1,
    0,
    'Rooftop confrontation',
    'On the rooftop, the standoff breaks.'
  ),
  psScene(PS_SCENE_2, 1, 'Neon alley escape', 'They bolt down the neon alley.'),
  psScene(PS_SCENE_3, 2, 'Coda', 'The city exhales.'),
];

const defaultArgs = {
  sequenceId: PS_SEQ,
  className: 'w-[360px]',
  shots: [] as typeof mockShots,
  scenes: [],
  selection: { sceneIds: [] as string[] },
  aspectRatio: DEFAULT_ASPECT_RATIO,
  sequenceModels: { imageModel: 'nano_banana', videoModel: 'veo3' },
  onSelectScene: () => console.log('onSelectScene'),
  onSelectShot: (shotId: string) => console.log('onSelectShot', shotId),
  onClearSelection: () => console.log('onClearSelection'),
  regeneratingImages: new Set<string>(),
  regeneratingMotion: new Set<string>(),
  musicPromptsReady: false,
};

const meta: Meta<typeof SceneList> = {
  title: 'Scenes/SceneList',
  component: SceneList,
  decorators: [
    (Story) => (
      <div className="h-screen">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
  },
  args: defaultArgs,
};

export default meta;
type Story = StoryObj<typeof SceneList>;

export const WithScenes: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [], shotId: mockShots[1]?.id },
  },
};

/**
 * Per-segment video (#986): 3 scenes, 9 shots, 4 render segments. Scene 1's
 * shots 1–3 share one video and 4–5 share another (two brackets, same model);
 * scene 2's three shots are all one video; scene 3's single shot is still
 * bracketed so its model shows. Every bracket carries the video model (the
 * scene header no longer does), the shot count only when >1, and a Stale badge
 * on segment 1b.
 */
export const PerSegmentVideo: Story = {
  args: {
    shots: perSegmentShots,
    scenes: perSegmentScenes,
    segments: perSegmentSegments,
    selection: { sceneIds: [] },
  },
};

export const NoSelectedScene: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [] },
  },
};

export const MultipleCompleted: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [], shotId: mockShots[0]?.id },
  },
};

export const AllCompleted: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [] },
  },
};

export const Empty: Story = {
  args: {
    shots: [],
    selection: { sceneIds: [] },
  },
};

export const ManyScenes: Story = {
  args: {
    shots: generateMockShots(15, 'mock-sequence-id'),
    selection: { sceneIds: [] },
  },
};

export const GeneratingThumbnails: Story = {
  args: {
    shots: mockShots.map((shot, idx) => ({
      ...shot,
      frame: {
        ...shot.frame,
        imageStatus: idx < 3 ? ('generating' as const) : ('completed' as const),
      },
      image: idx < 3 ? null : shot.image,
    })),
    selection: { sceneIds: [], shotId: mockShots[0]?.id },
  },
};

export const WithFailures: Story = {
  args: {
    shots: mockShots.map((shot, idx) => ({
      ...shot,
      frame: {
        ...shot.frame,
        imageStatus: idx === 2 ? ('failed' as const) : ('completed' as const),
        imageError: idx === 2 ? 'Generation timeout' : null,
      },
      image: idx === 2 ? null : shot.image,
    })),
    selection: { sceneIds: [] },
  },
};

export const MixedStates: Story = {
  args: {
    shots: mockShots.map((shot, idx) => {
      if (idx === 0) {
        return {
          ...shot,
          frame: { ...shot.frame, imageStatus: 'pending' as const },
          image: null,
        };
      }
      if (idx === 1) {
        return {
          ...shot,
          frame: { ...shot.frame, imageStatus: 'generating' as const },
          image: null,
        };
      }
      if (idx === 2) {
        return {
          ...shot,
          frame: {
            ...shot.frame,
            imageStatus: 'failed' as const,
            imageError: 'API error',
          },
          image: null,
        };
      }
      return {
        ...shot,
        frame: { ...shot.frame, imageStatus: 'completed' as const },
      };
    }),
    selection: { sceneIds: [], shotId: mockShots[1]?.id },
  },
};

export const WidthMedium: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [], shotId: mockShots[1]?.id },
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <div className="[&>div]:w-96">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const WidthLarge: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [], shotId: mockShots[1]?.id },
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <div className="[&>div]:w-lg">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const WidthExtraLarge: Story = {
  args: {
    shots: mockShots,
    selection: { sceneIds: [], shotId: mockShots[1]?.id },
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <div className="[&>div]:w-xl">
          <Story />
        </div>
      </div>
    ),
  ],
};
