import type { SceneWithScript } from '@/hooks/use-scenes';
import { dbSceneId } from '@/lib/db/schema';
import { frameFixture, frameVariantFixture } from '@/lib/mocks/frame-fixtures';
import { toShotView, type ShotView } from '@/lib/shots/shot-view';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import {
  SceneScriptPrompts,
  tabsForScope,
  type TabValue,
} from './scene-script-prompts';

const anchorFrame = frameFixture({
  id: 'frame-1',
  shotId: 'shot-1',
  sequenceId: 'seq-1',
  imageStatus: 'completed',
});

const mockShot: ShotView = toShotView(
  {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: 'scene-1',
    shotNumber: 1,
    durationMs: 3000,
    useStartFrame: null,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  anchorFrame,
  {
    image: frameVariantFixture({
      frameId: anchorFrame.id,
      sequenceId: 'seq-1',
      url: 'https://picsum.photos/seed/coffee/320/180',
      storagePath: 'teams/mock/sequences/mock/frames/shot-1/thumbnail.jpg',
    }),
    preview: null,
    imagePromptVersion: null,
    video: null,
    primaryVideo: null,
  }
);

// The script, title and continuity the tabs read live on the scene (#1067).
const mockScene: SceneWithScript = {
  id: dbSceneId('scene-1'),
  sequenceId: 'seq-1',
  orderIndex: 0,
  location: 'Coffee Shop',
  timeOfDay: 'Morning',
  storyBeat: 'Establish protagonist stress and setting',
  title: 'Coffee Shop Introduction',
  continuity: {
    characterTags: [],
    environmentTag: '',
    elementTags: [],
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  },
  script: {
    extract:
      'INT. COFFEE SHOP - MORNING\n\nSARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte.',
    dialogue: [
      {
        character: 'SARAH',
        line: 'This deadline is going to kill me.',
        tone: '',
      },
    ],
  },
  selectedScriptVersionId: null,
  deletedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const meta: Meta<typeof SceneScriptPrompts> = {
  title: 'Scenes/SceneScriptPrompts',
  component: SceneScriptPrompts,
  parameters: {
    layout: 'centered',
  },
  args: {
    sequenceId: 'seq-1',
    scene: mockScene,
    selectedTab: 'script' as TabValue,
    visibleTabs: tabsForScope('shot'),
    onTabChange: fn(),
    regeneratingImages: new Set<string>(),
    regeneratingMotion: new Set<string>(),
    onRegenerateStart: fn(),
    // Resolved per-asset models (#1066) — these are required props; without
    // them IMAGE_TO_VIDEO_MODELS[undefined] is undefined and the component
    // crashes on `'requiredStyleCategory' in undefined`.
    resolvedImageModel: 'gpt_image_2',
    resolvedVideoModel: 'seedance_v2',
  },
  decorators: [
    (Story) => (
      <div className="w-[600px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SceneScriptPrompts>;

export const Default: Story = {
  args: {
    shot: mockShot,
  },
};

export const Loading: Story = {
  args: {
    shot: undefined,
  },
};

export const PartiallyLoaded: Story = {
  args: {
    shot: mockShot,
    scene: undefined,
  },
};

export const LongScript: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: 8500,
    },
    scene: {
      ...mockScene,
      script: {
        extract: `INT. COFFEE SHOP - MORNING

SARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte. The morning sun streams through large windows, casting long shadows across the wooden floor.

Other patrons bustle about, ordering drinks and chatting, creating a backdrop of ambient noise that Sarah tries to tune out. Her phone BUZZES. She glances at it, frowns, and silences it without reading the message.

BARISTA (O.S.)
    Large oat milk latte for Sarah!

Sarah doesn't respond, too absorbed in her work. The barista shrugs and sets the drink aside.`,
        dialogue: [
          {
            character: 'BARISTA',
            line: 'Large oat milk latte for Sarah!',
            tone: '',
          },
        ],
      },
    },
  },
};

export const LongPrompts: Story = {
  args: {
    shot: mockShot,
  },
};

export const ImagePromptTab: Story = {
  args: {
    shot: {
      ...mockShot,
      imagePromptVersion: {
        id: 'fpv-1',
        frameId: anchorFrame.id,
        text: 'Wide shot of Sarah at a sunlit coffee shop, typing furiously, steam rising from an untouched latte.',
        components: null,
        source: 'ai-generated',
        inputHash: null,
        analysisModel: null,
        status: 'completed',
        pendingInputHash: null,
        workflowRunId: null,
        createdAt: new Date(),
        createdBy: null,
      },
    },
    selectedTab: 'image-prompt',
  },
};

export const MotionPromptTab: Story = {
  args: {
    shot: {
      ...mockShot,
      motionPrompt: {
        fullPrompt:
          'Slow push in as Sarah types; her eyes flick to the silenced phone.',
        dialogue: {
          presence: true,
          lines: [
            {
              character: 'SARAH',
              line: 'This deadline is going to kill me.',
              tone: '',
            },
          ],
        },
        audio: null,
      },
    },
    selectedTab: 'motion-prompt',
  },
};

export const ShortScript: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: 1500,
    },
    scene: {
      ...mockScene,
      script: {
        extract: 'INT. COFFEE SHOP - MORNING\n\nSARAH types on laptop.',
        dialogue: [],
      },
    },
  },
};

export const NoDuration: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: null,
    },
  },
};
