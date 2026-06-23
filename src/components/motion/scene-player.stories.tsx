/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Storybook mock data uses intentional type assertions */
import type { Shot } from '@/types/database';
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

const mockShotBase = {
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: null,
  orderIndex: 0,
  description: 'A scene from the storyboard',
  durationMs: 5000,
  thumbnailWorkflowRunId: null,
  thumbnailGeneratedAt: null,
  thumbnailError: null,
  imageModel: 'nano_banana',
  imagePrompt: null,
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionPrompt: null,
  motionModel: 'veo3',
  audioUrl: null,
  audioPath: null,
  audioStatus: 'pending' as const,
  audioWorkflowRunId: null,
  audioGeneratedAt: null,
  audioError: null,
  audioModel: null,
  thumbnailInputHash: null,
  variantImageInputHash: null,
  videoInputHash: null,
  audioInputHash: null,
  visualPromptInputHash: null,
  motionPromptInputHash: null,
  variantImageUrl: null,
  variantImageStatus: 'pending' as const,
  variantWorkflowRunId: null,
  variantImageGeneratedAt: null,
  variantImageError: null,
  previewThumbnailUrl: null,
  metadata: {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: {
      extract: 'Sample scene text',
      dialogue: [],
    },
    metadata: {
      title: 'Opening Scene',
      durationSeconds: 5,
      location: 'Forest',
      timeOfDay: 'Dawn',
      storyBeat: 'Introduction',
    },
    selectedVariant: {
      cameraAngle: 'A1' as const,
      movementStyle: 'B1' as const,
      moodTreatment: 'C1' as const,
      rationale: 'Sample rationale',
    },
    prompts: {
      visual: {
        fullPrompt: 'Sample visual prompt',
        negativePrompt: '',
        components: {
          sceneDescription: 'Forest scene',
          subject: 'Character',
          environment: 'Forest',
          lighting: 'Dawn light',
          camera: 'Wide shot',
          composition: 'Centered',
          style: 'Cinematic',
          technical: 'High detail',
          atmosphere: 'Mysterious',
        },
        parameters: {
          dimensions: { width: 1280, height: 720, aspectRatio: '16:9' },
          quality: { steps: 30, guidance: 7.5 },
          control: 0.8,
        },
      },
      motion: {
        fullPrompt: 'Sample motion prompt',
        components: {
          cameraMovement: 'Slow pan',
          startPosition: 'Left',
          endPosition: 'Right',
          durationSeconds: 5,
          speed: 'slow',
          smoothness: 'smooth',
          subjectTracking: 'follow',
          equipment: 'slider',
        },
        parameters: {
          durationSeconds: 5,
          fps: 24,
          motionAmount: 0.5,
          cameraControl: 0.7,
        },
      },
    },
    continuity: {
      characterTags: ['hero'],
      environmentTag: 'forest',
      colorPalette: 'cool',
      lightingSetup: 'natural',
    },
  },
  createdAt: new Date(),
  updatedAt: new Date(),
};

// Mock frames with scene metadata
const mockShots: Shot[] = [
  {
    ...mockShotBase,
    id: '1',
    orderIndex: 0,
    thumbnailUrl: 'https://picsum.photos/seed/scene1/1280/720',
    thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
    variantImageUrl: 'https://picsum.photos/seed/scene1/1280/720',
    videoUrl:
      'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
    videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
    thumbnailStatus: 'completed',
    videoStatus: 'completed',
    variantImageStatus: 'completed',
    metadata: {
      ...mockShotBase.metadata,
      sceneNumber: 1,
      metadata: { ...mockShotBase.metadata.metadata, title: 'Opening Scene' },
    } as unknown as Shot['metadata'],
  },
  {
    ...mockShotBase,
    id: '2',
    orderIndex: 1,
    thumbnailUrl: 'https://picsum.photos/seed/scene2/1280/720',
    thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
    variantImageUrl: 'https://picsum.photos/seed/scene2/1280/720',
    videoUrl:
      'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
    videoPath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
    thumbnailStatus: 'completed',
    videoStatus: 'completed',
    variantImageStatus: 'completed',
    metadata: {
      ...mockShotBase.metadata,
      sceneNumber: 2,
      metadata: { ...mockShotBase.metadata.metadata, title: 'The Journey' },
    } as unknown as Shot['metadata'],
  },
  {
    ...mockShotBase,
    id: '3',
    orderIndex: 2,
    thumbnailUrl: 'https://picsum.photos/seed/scene3/1280/720',
    thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
    variantImageUrl: 'https://picsum.photos/seed/scene3/1280/720',
    videoUrl: null,
    videoPath: null,
    thumbnailStatus: 'completed',
    videoStatus: 'pending',
    variantImageStatus: 'pending',
    metadata: {
      ...mockShotBase.metadata,
      sceneNumber: 3,
      metadata: { ...mockShotBase.metadata.metadata, title: 'Climax' },
    } as unknown as Shot['metadata'],
  },
];

// Note: This component now shows ALL frames with completed thumbnails, not just completed videos.
// Frames with pending/generating/failed video status show poster frame with status overlay.

export const WithMockSequence: Story = {
  args: {
    selectedFrameId: '1',
    shots: mockShots,
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
    selectedFrameId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/state1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/state1/thumbnail.jpg',
        variantImageUrl: 'https://picsum.photos/seed/state1/1280/720',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/state1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        variantImageStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Completed Video',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/state2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/state2/thumbnail.jpg',
        variantImageUrl: 'https://picsum.photos/seed/state2/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        variantImageStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Pending Video',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/state3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/state3/thumbnail.jpg',
        variantImageUrl: 'https://picsum.photos/seed/state3/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'generating',
        variantImageStatus: 'generating',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Generating Video',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '4',
        orderIndex: 3,
        thumbnailUrl: 'https://picsum.photos/seed/state4/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/state4/thumbnail.jpg',
        variantImageUrl: 'https://picsum.photos/seed/state4/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'failed',
        variantImageStatus: 'failed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 4,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Failed Video',
          },
        } as unknown as Shot['metadata'],
      },
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
    selectedFrameId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/pending1/1280/720',
        thumbnailPath:
          'teams/mock/sequences/mock/frames/pending1/thumbnail.jpg',
        variantImageUrl: 'https://picsum.photos/seed/pending1/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        variantImageStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Pending Scene 1',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/pending2/1280/720',
        thumbnailPath:
          'teams/mock/sequences/mock/frames/pending2/thumbnail.jpg',
        variantImageUrl: 'https://picsum.photos/seed/pending2/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        variantImageStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Pending Scene 2',
          },
        } as unknown as Shot['metadata'],
      },
    ],
  },
  parameters: {
    docs: {
      description: {
        story:
          'All frames have completed thumbnails but pending videos. Shows how the player handles a sequence where no videos are ready yet.',
      },
    },
  },
};

export const FailedVideoWithThumbnail: Story = {
  args: {
    selectedFrameId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/failed-thumb/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/failed/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        variantImageUrl: null,
        thumbnailStatus: 'completed',
        videoStatus: 'failed',
        videoError: 'Model generation timeout',
        variantImageStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Failed Video Generation',
          },
        } as unknown as Shot['metadata'],
      },
    ],
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
    selectedFrameId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview1/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        variantImageStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Preview - Generating Full Image',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview2/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        variantImageStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Preview - Still Processing',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/final3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        previewThumbnailUrl: 'https://picsum.photos/seed/preview3/1280/720',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        variantImageStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Final Image Ready',
          },
        } as unknown as Shot['metadata'],
      },
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
    selectedFrameId: '1',
    aspectRatio: '16:9',
    onSelectShot: () => {},
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        variantImageUrl: null,
        thumbnailStatus: 'failed',
        videoStatus: 'failed',
        thumbnailError: 'Image generation failed',
        variantImageStatus: 'pending',
        videoError: 'Cannot generate video without thumbnail',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Complete Failure',
          },
        } as unknown as Shot['metadata'],
      },
    ],
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
