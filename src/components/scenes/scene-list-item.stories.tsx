import { dbSceneId } from '@/lib/db/schema';
import type { SceneWithScript } from '@/hooks/use-scenes';
import { frameFixture, frameVariantFixture } from '@/lib/mocks/frame-fixtures';
import { toShotView, type ShotView } from '@/lib/shots/shot-view';
import type { Meta, StoryObj } from '@storybook/react';
import { SceneListItem } from './scene-list-item';

const anchorFrame = frameFixture({
  shotId: 'shot-1',
  sequenceId: 'seq-1',
  imageStatus: 'completed',
});

const mockShot: ShotView = toShotView(
  {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
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

const mockScene: SceneWithScript = {
  id: dbSceneId('scene-1'),
  sequenceId: 'seq-1',
  orderIndex: 0,
  location: 'Coffee Shop',
  timeOfDay: 'Morning',
  storyBeat: 'Establish protagonist stress and setting',
  title: 'Coffee Shop Introduction',
  continuity: null,
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

const meta: Meta<typeof SceneListItem> = {
  title: 'Scenes/SceneListItem',
  component: SceneListItem,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  args: {
    scene: mockScene,
    onSelect: () => console.log('onSelect'),
  },
};

export default meta;
type Story = StoryObj<typeof SceneListItem>;

export const Inactive: Story = {
  args: {
    shot: mockShot,
    isActive: false,
  },
};

export const Active: Story = {
  args: {
    shot: mockShot,
    isActive: true,
  },
};

export const Completed: Story = {
  args: {
    shot: mockShot,
    isActive: false,
  },
};

export const ActiveAndCompleted: Story = {
  args: {
    shot: mockShot,
    isActive: true,
  },
};

export const Generating: Story = {
  args: {
    shot: {
      ...mockShot,
      image: null,
      frame: { ...mockShot.frame, imageStatus: 'generating' },
    },
    isActive: false,
  },
};

export const GeneratingActive: Story = {
  args: {
    shot: {
      ...mockShot,
      image: null,
      frame: { ...mockShot.frame, imageStatus: 'generating' },
    },
    isActive: true,
  },
};

export const Failed: Story = {
  args: {
    shot: {
      ...mockShot,
      image: null,
      frame: {
        ...mockShot.frame,
        imageStatus: 'failed',
        imageError: 'Generation timeout',
      },
    },
    isActive: false,
  },
};

export const LongTitle: Story = {
  args: {
    shot: mockShot,
    scene: {
      ...mockScene,
      title:
        'An Extremely Long Scene Title That Should Wrap Properly Without Breaking Layout',
    },
    isActive: false,
  },
};

export const LongScript: Story = {
  args: {
    shot: mockShot,
    scene: {
      ...mockScene,
      script: {
        extract:
          'INT. COFFEE SHOP - MORNING\n\nSARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte. The morning sun streams through large windows, casting long shadows across the wooden floor. Other patrons bustle about, ordering drinks and chatting, creating a backdrop of ambient noise that Sarah tries to tune out.',
        dialogue: [],
      },
    },
    isActive: false,
  },
};
