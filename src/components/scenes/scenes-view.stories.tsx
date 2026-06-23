/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Storybook mock data uses intentional type assertions */
import { ScenesView } from '@/components/scenes/scenes-view';
import type { Shot, Sequence } from '@/types/database';
import type { Meta, StoryObj } from '@storybook/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

// Extend the component props to include frames for story mocking
// Frames are passed through parameters, not args, so make them optional
type ScenesViewStoryProps = React.ComponentProps<typeof ScenesView> & {
  frames?: Shot[];
};

const mockSequence: Sequence = {
  id: 'demo-sequence-123',
  teamId: 'team-1',
  title: 'Demo Sequence',
  script: 'Sample script text for the demo sequence.',
  status: 'completed',
  statusError: null,
  workflowRunId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'user-1',
  updatedBy: 'user-1',
  styleId: 'style-1',
  aspectRatio: '16:9',
  analysisModel: 'anthropic/claude-haiku-4.5',
  analysisDurationMs: 0,
  imageModel: 'nano_banana',
  videoModel: 'veo3',
  workflow: null,
  musicUrl: null,
  musicPath: null,
  musicStatus: 'pending',
  musicGeneratedAt: null,
  musicError: null,
  musicModel: null,
  musicPrompt: null,
  musicTags: null,
  musicPromptInputHash: null,
  includeMusic: true,
  posterUrl: null,
  autoGenerateMotion: false,
  autoGenerateMusic: false,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
};

const meta = {
  title: 'Scenes/ScenesView',
  component: ScenesView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story, context) => {
      // Get frames from story parameters (not args since ScenesView doesn't accept them)
      const shots = context.parameters.frames as Shot[];
      const sequenceId = context.args.sequenceId || 'mock-sequence';
      const sequenceOverrides = context.parameters
        .sequenceOverrides as Partial<Sequence>;

      // Create a query client with mock data
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      });

      // Pre-populate the cache with mock data using the correct query keys
      queryClient.setQueryData(['shots', 'list', sequenceId], shots);
      queryClient.setQueryData(['sequences', 'detail', sequenceId], {
        ...mockSequence,
        id: sequenceId,
        ...sequenceOverrides,
      });

      // Provide a minimal TanStack Router context for useNavigate()
      const rootRoute = createRootRoute({
        component: () => <Story />,
      });
      const router = createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ['/'] }),
      });

      return (
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      );
    },
  ],
} satisfies Meta<ScenesViewStoryProps>;

export default meta;
type Story = StoryObj<typeof meta>;

// Mock frame base — all Shot fields included
const mockShotBase = {
  sequenceId: 'seq-1',
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

export const MixedStates: Story = {
  args: {
    sequenceId: 'demo-sequence-123',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/scene1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Opening Scene',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/scene2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'The Journey',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/scene3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: { ...mockShotBase.metadata.metadata, title: 'Climax' },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '4',
        orderIndex: 3,
        thumbnailUrl: 'https://picsum.photos/seed/scene4/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/4/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'generating',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 4,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Resolution',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '5',
        orderIndex: 4,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 5,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Epilogue',
          },
        } as unknown as Shot['metadata'],
      },
    ],
    docs: {
      description: {
        story:
          'Full scenes page with mixed states. Scenes 1-2 have completed videos and play normally. Scene 3 shows "Generating video..." overlay. Scene 4 is generating video. Scene 5 is still generating its frame (appears in list but not player).',
      },
    },
  },
};

export const AllCompleted: Story = {
  args: {
    sequenceId: 'all-completed',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/complete1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: { ...mockShotBase.metadata.metadata, title: 'Scene 1' },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/complete2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/2/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: { ...mockShotBase.metadata.metadata, title: 'Scene 2' },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/complete3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/3/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: { ...mockShotBase.metadata.metadata, title: 'Scene 3' },
        } as unknown as Shot['metadata'],
      },
    ],
    docs: {
      description: {
        story:
          'All scenes have completed videos. Demonstrates sequential playback of multiple videos. Videos will auto-advance from one to the next.',
      },
    },
  },
};

export const AllPending: Story = {
  args: {
    sequenceId: 'all-pending',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/pending1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Waiting for Video 1',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/pending2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Waiting for Video 2',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/pending3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Waiting for Video 3',
          },
        } as unknown as Shot['metadata'],
      },
    ],
    docs: {
      description: {
        story:
          'All scenes have thumbnails but are waiting for video generation. Player shows pending overlay on each scene.',
      },
    },
  },
};

export const FramesGenerating: Story = {
  args: {
    sequenceId: 'frames-generating',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/framegen1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Scene 1 - Ready',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/framegen2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Scene 2 - Shot Ready',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Scene 3 - Generating Frame',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '4',
        orderIndex: 3,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'pending',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 4,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Scene 4 - Shot Pending',
          },
        } as unknown as Shot['metadata'],
      },
    ],
    docs: {
      description: {
        story:
          'Shows frames at different stages of generation. Scene 1 is complete and playable. Scene 2 has frame ready, shows "Generating video..." in player. Scenes 3-4 are generating/pending frames (visible in list with skeleton, not in player).',
      },
    },
  },
};

export const GenerationInProgress: Story = {
  args: {
    sequenceId: 'generating',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/gen1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'generating',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Video Generating',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Frame Generating',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: null,
        thumbnailPath: null,
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'pending',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Frame Pending',
          },
        } as unknown as Shot['metadata'],
      },
    ],
    docs: {
      description: {
        story:
          'Multiple scenes in generation. Scene 1 shows "Generating video..." in player. Scenes 2-3 are generating/pending frames (visible in list only, not player).',
      },
    },
  },
};

export const PreviewMode: Story = {
  args: {
    sequenceId: 'preview-mode',
  },
  parameters: {
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
    docs: {
      description: {
        story:
          'Shows preview mode where fast preview images are displayed while full-resolution thumbnails are still generating. Scenes 1-2 show the "Preview" badge, Scene 3 has its final image ready (no badge).',
      },
    },
  },
};

export const PreviewModePortrait: Story = {
  args: {
    sequenceId: 'preview-mode-portrait',
  },
  parameters: {
    sequenceOverrides: { aspectRatio: '9:16' },
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: null,
        thumbnailPath: null,
        previewThumbnailUrl: 'https://picsum.photos/seed/preview1p/720/1280',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
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
        previewThumbnailUrl: 'https://picsum.photos/seed/preview2p/720/1280',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'generating',
        videoStatus: 'pending',
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
        thumbnailUrl: 'https://picsum.photos/seed/final3p/720/1280',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        previewThumbnailUrl: 'https://picsum.photos/seed/preview3p/720/1280',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
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
    docs: {
      description: {
        story:
          'Portrait (9:16) preview mode. Shows preview badge and subtext on tall aspect ratio frames.',
      },
    },
  },
};

export const WithFailures: Story = {
  args: {
    sequenceId: 'with-failures',
  },
  parameters: {
    shots: [
      {
        ...mockShotBase,
        id: '1',
        orderIndex: 0,
        thumbnailUrl: 'https://picsum.photos/seed/fail1/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/1/thumbnail.jpg',
        videoUrl:
          'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
        videoPath: 'teams/mock/sequences/mock/frames/1/motion.mp4',
        thumbnailStatus: 'completed',
        videoStatus: 'completed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 1,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Successful Scene',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '2',
        orderIndex: 1,
        thumbnailUrl: 'https://picsum.photos/seed/fail2/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/2/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'failed',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 2,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Failed Generation',
          },
        } as unknown as Shot['metadata'],
      },
      {
        ...mockShotBase,
        id: '3',
        orderIndex: 2,
        thumbnailUrl: 'https://picsum.photos/seed/fail3/1280/720',
        thumbnailPath: 'teams/mock/sequences/mock/frames/3/thumbnail.jpg',
        videoUrl: null,
        videoPath: null,
        thumbnailStatus: 'completed',
        videoStatus: 'pending',
        metadata: {
          ...mockShotBase.metadata,
          sceneNumber: 3,
          metadata: {
            ...mockShotBase.metadata.metadata,
            title: 'Pending Scene',
          },
        } as unknown as Shot['metadata'],
      },
    ],
    docs: {
      description: {
        story:
          'Demonstrates error handling. Scene 1 plays normally, Scene 2 shows failed state with error icon, Scene 3 is pending.',
      },
    },
  },
};

export const EmptySequence: Story = {
  args: {
    sequenceId: 'empty-sequence',
  },
  parameters: {
    shots: [],
    docs: {
      description: {
        story:
          'Empty sequence with no frames. Shows how the page handles sequences without any scenes.',
      },
    },
  },
};
