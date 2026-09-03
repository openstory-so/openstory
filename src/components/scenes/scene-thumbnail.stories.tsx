import type { Meta, StoryObj } from '@storybook/react';
import { SceneThumbnail } from './scene-thumbnail';

const meta: Meta<typeof SceneThumbnail> = {
  title: 'Scenes/SceneThumbnail',
  component: SceneThumbnail,
  parameters: {
    layout: 'centered',
  },
  args: {
    aspectRatio: '16:9',
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SceneThumbnail>;

export const Pending: Story = {
  args: {
    thumbnailStatus: 'pending',
    alt: 'Scene 1',
  },
};

export const Generating: Story = {
  args: {
    thumbnailStatus: 'generating',
    alt: 'Scene 1',
  },
};

export const Preview: Story = {
  args: {
    previewThumbnailUrl: 'https://picsum.photos/seed/preview1/320/180',
    thumbnailStatus: 'generating',
    alt: 'Scene 1 - Preview while generating',
  },
};

export const GeneratingWithStill: Story = {
  args: {
    thumbnailUrl: 'https://picsum.photos/seed/scene1/320/180',
    thumbnailStatus: 'generating',
    alt: 'Scene 1 — still visible while regenerating',
  },
};

export const UpscalingFromCrop: Story = {
  args: {
    thumbnailUrl: 'https://picsum.photos/seed/scene1/320/180',
    thumbnailStatus: 'generating',
    pendingUpscaleUrl: 'https://picsum.photos/seed/crop1/320/180',
    alt: 'Scene 1 — cropped tile while upscaling',
  },
};

export const UpscalingFromGridCell: Story = {
  args: {
    thumbnailUrl: 'https://picsum.photos/seed/scene1/320/180',
    thumbnailStatus: 'generating',
    gridSheetUrl: 'https://picsum.photos/seed/grid1/960/540',
    pendingUpscaleIndex: 4,
    alt: 'Scene 1 — CSS-cropped grid cell while upscaling',
  },
};

export const Completed: Story = {
  args: {
    thumbnailUrl: 'https://picsum.photos/seed/scene1/320/180',
    thumbnailStatus: 'completed',
    alt: 'Scene 1',
  },
};

export const Failed: Story = {
  args: {
    thumbnailStatus: 'failed',
    alt: 'Scene 1',
  },
};

export const ContentBlocked: Story = {
  args: {
    thumbnailStatus: 'failed',
    generationError:
      'The content could not be processed because it contained material flagged by a content checker.',
    alt: 'Scene 1',
  },
};

export const CompletedWithDifferentImage: Story = {
  args: {
    thumbnailUrl: 'https://picsum.photos/seed/scene2/320/180',
    thumbnailStatus: 'completed',
    alt: 'Scene 2 - Different composition',
  },
};

export const ClipFirstFrame: Story = {
  args: {
    videoUrl:
      'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    thumbnailStatus: 'pending',
    alt: 'Scene 1 — reference-only shot, showing the clip first frame',
  },
};

export const ClipFirstFrameBeatsPreview: Story = {
  args: {
    previewThumbnailUrl: 'https://picsum.photos/seed/preview1/320/180',
    videoUrl:
      'https://storage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4',
    alt: 'Scene 1 — storyboard preview is superseded once the clip exists',
  },
};
