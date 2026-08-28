import type { SceneWithScript } from '@/hooks/use-scenes';
import {
  dbSceneId,
  type Frame,
  type FrameVariant,
  type VideoVariant,
} from '@/lib/db/schema';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import {
  toShotView,
  type ShotGridSheet,
  type ShotView,
} from '@/lib/shots/shot-view';
import type { Meta, StoryObj } from '@storybook/react';
import { ScenePlayer } from './scene-player';

const meta: Meta<typeof ScenePlayer> = {
  title: 'Motion/ScenePlayer',
  component: ScenePlayer,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof ScenePlayer>;

/**
 * A shot owns no assets (#1067): its still lives on the anchor frame's selected
 * `frame_variants` row and its video on the segment's `video_variants` rows.
 * Each mock names those rows' real columns; `mockShot` assembles them the way a
 * read path does — `render` is the segment's newest primary render, and only a
 * completed one is selectable, so the selection is url-gated off the same row.
 */
const mockShot = (spec: {
  id: string;
  sceneId: string;
  frame?: Partial<Frame>;
  image?: Partial<FrameVariant>;
  render?: Partial<VideoVariant>;
  gridSheet?: ShotGridSheet;
}): ShotView => {
  const now = new Date();
  const frame = frameFixture({
    shotId: spec.id,
    sequenceId: 'seq-1',
    ...spec.frame,
  });
  const image = spec.image
    ? frameVariantFixture({
        frameId: frame.id,
        sequenceId: 'seq-1',
        ...spec.image,
      })
    : null;
  const render = spec.render
    ? videoVariantFixture({
        renderSegmentId: `${spec.id}-segment`,
        sequenceId: 'seq-1',
        model: 'veo3',
        ...spec.render,
      })
    : null;
  return toShotView(
    {
      id: spec.id,
      sequenceId: 'seq-1',
      sceneId: spec.sceneId,
      shotNumber: 1,
      durationMs: 5000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    frame,
    {
      image,
      preview: null,
      imagePromptVersion: null,
      video: render?.url ? render : null,
      primaryVideo: render,
      gridSheet: spec.gridSheet ?? null,
    }
  );
};

/**
 * The player takes its title from the shot's scene (#1067), so each mock shot
 * points at one of these by `sceneId: 'scene-<n>'`.
 */
const mockScene = (orderIndex: number, title: string): SceneWithScript => ({
  id: dbSceneId(`scene-${orderIndex + 1}`),
  sequenceId: 'seq-1',
  orderIndex,
  location: 'Forest',
  timeOfDay: 'Dawn',
  storyBeat: 'Introduction',
  title,
  continuity: null,
  script: { extract: 'Sample scene text', dialogue: [] },
  selectedScriptVersionId: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

// Mock shots with scene metadata
const mockShots: ShotView[] = [
  mockShot({
    id: '1',
    sceneId: 'scene-1',
    frame: { imageStatus: 'completed' },
    image: {
      url: 'https://picsum.photos/seed/scene1/1280/720',
      storagePath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      storagePath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
      status: 'completed',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/scene1/1280/720',
      status: 'completed',
    },
  }),
  mockShot({
    id: '2',
    sceneId: 'scene-2',
    frame: { imageStatus: 'completed' },
    image: {
      url: 'https://picsum.photos/seed/scene2/1280/720',
      storagePath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
      storagePath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
      status: 'completed',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/scene2/1280/720',
      status: 'completed',
    },
  }),
  mockShot({
    id: '3',
    sceneId: 'scene-3',
    frame: { imageStatus: 'completed' },
    image: { url: 'https://picsum.photos/seed/scene3/1280/720' },
    render: { status: 'pending' },
    gridSheet: {
      url: 'https://picsum.photos/seed/scene3/1280/720',
      status: 'pending',
    },
  }),
];

const mockScenes: SceneWithScript[] = [
  mockScene(0, 'Opening Scene'),
  mockScene(1, 'The Journey'),
  mockScene(2, 'Climax'),
];

// Note: This component now shows ALL shots with completed thumbnails, not just completed videos.
// Shots with pending/generating/failed video status show poster frame with status overlay.

export const WithMockSequence: Story = {
  args: {
    selectedShotId: '1',
    shots: mockShots,
    scenes: mockScenes,
    aspectRatio: '16:9',
    onSelectShot: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates sequential playback with mixed video states. Scene 1-2 play videos, Scene 3 shows pending overlay on poster frame. Navigate through scenes to see different states.',
      },
    },
  },
};

export const AllVideoStates: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      mockShot({
        id: '1',
        sceneId: 'scene-1',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/state1/1280/720',
          storagePath: 'teams/mock/sequences/mock/frames/state1/thumbnail.jpg',
        },
        render: {
          url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
          storagePath: 'teams/mock/sequences/mock/frames/state1/motion.mp4',
          status: 'completed',
        },
        gridSheet: {
          url: 'https://picsum.photos/seed/state1/1280/720',
          status: 'completed',
        },
      }),
      mockShot({
        id: '2',
        sceneId: 'scene-2',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/state2/1280/720',
          storagePath: 'teams/mock/sequences/mock/frames/state2/thumbnail.jpg',
        },
        render: { status: 'pending' },
        gridSheet: {
          url: 'https://picsum.photos/seed/state2/1280/720',
          status: 'pending',
        },
      }),
      mockShot({
        id: '3',
        sceneId: 'scene-3',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/state3/1280/720',
          storagePath: 'teams/mock/sequences/mock/frames/state3/thumbnail.jpg',
        },
        render: { status: 'generating' },
        gridSheet: {
          url: 'https://picsum.photos/seed/state3/1280/720',
          status: 'generating',
        },
      }),
      mockShot({
        id: '4',
        sceneId: 'scene-4',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/state4/1280/720',
          storagePath: 'teams/mock/sequences/mock/frames/state4/thumbnail.jpg',
        },
        render: { status: 'failed' },
        gridSheet: {
          url: 'https://picsum.photos/seed/state4/1280/720',
          status: 'failed',
        },
      }),
    ],
    scenes: [
      mockScene(0, 'Completed Video'),
      mockScene(1, 'Pending Video'),
      mockScene(2, 'Generating Video'),
      mockScene(3, 'Failed Video'),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows all possible video states: completed (plays video), pending (clock icon), generating (spinner), and failed (error icon). Navigate through scenes to see each state overlay.',
      },
    },
  },
};

export const OnlyPendingVideos: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      mockShot({
        id: '1',
        sceneId: 'scene-1',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/pending1/1280/720',
          storagePath:
            'teams/mock/sequences/mock/frames/pending1/thumbnail.jpg',
        },
        render: { status: 'pending' },
        gridSheet: {
          url: 'https://picsum.photos/seed/pending1/1280/720',
          status: 'pending',
        },
      }),
      mockShot({
        id: '2',
        sceneId: 'scene-2',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/pending2/1280/720',
          storagePath:
            'teams/mock/sequences/mock/frames/pending2/thumbnail.jpg',
        },
        render: { status: 'pending' },
        gridSheet: {
          url: 'https://picsum.photos/seed/pending2/1280/720',
          status: 'pending',
        },
      }),
    ],
    scenes: [mockScene(0, 'Pending Scene 1'), mockScene(1, 'Pending Scene 2')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'All shots have completed thumbnails but pending videos. Shows how the player handles a sequence where no videos are ready yet.',
      },
    },
  },
};

export const FailedVideoWithThumbnail: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      mockShot({
        id: '1',
        sceneId: 'scene-1',
        frame: { imageStatus: 'completed' },
        image: {
          url: 'https://picsum.photos/seed/failed-thumb/1280/720',
          storagePath: 'teams/mock/sequences/mock/frames/failed/thumbnail.jpg',
        },
        render: { status: 'failed', error: 'Model generation timeout' },
        gridSheet: { url: null, status: 'completed' },
      }),
    ],
    scenes: [mockScene(0, 'Failed Video Generation')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Video generation failed but thumbnail succeeded. Shows error overlay with semi-transparent background over the thumbnail image.',
      },
    },
  },
};

export const PreviewMode: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      mockShot({
        id: '1',
        sceneId: 'scene-1',
        frame: {
          imageStatus: 'generating',
        },
        render: { status: 'pending' },
        gridSheet: { url: null, status: 'pending' },
      }),
      mockShot({
        id: '2',
        sceneId: 'scene-2',
        frame: {
          imageStatus: 'generating',
        },
        render: { status: 'pending' },
        gridSheet: { url: null, status: 'pending' },
      }),
      mockShot({
        id: '3',
        sceneId: 'scene-3',
        frame: {
          imageStatus: 'completed',
        },
        image: {
          url: 'https://picsum.photos/seed/final3/1280/720',
          storagePath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        },
        render: { status: 'pending' },
        gridSheet: { url: null, status: 'pending' },
      }),
    ],
    scenes: [
      mockScene(0, 'Preview - Generating Full Image'),
      mockScene(1, 'Preview - Still Processing'),
      mockScene(2, 'Final Image Ready'),
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows preview mode where fast preview images are displayed while full-resolution thumbnails are still generating. Scenes 1-2 show the "Preview" badge, Scene 3 has its final image ready.',
      },
    },
  },
};

export const FailedVideoWithoutThumbnail: Story = {
  args: {
    selectedShotId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      mockShot({
        id: '1',
        sceneId: 'scene-1',
        frame: {
          imageStatus: 'failed',
          imageError: 'Image generation failed',
        },
        render: {
          status: 'failed',
          error: 'Cannot generate video without thumbnail',
        },
        gridSheet: { url: null, status: 'pending' },
      }),
    ],
    scenes: [mockScene(0, 'Complete Failure')],
  },
  parameters: {
    docs: {
      description: {
        story:
          'Both thumbnail and video generation failed. Shows error overlay on a solid muted background since there is no thumbnail to display.',
      },
    },
  },
};
