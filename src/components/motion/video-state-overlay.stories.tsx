import type { Meta, StoryObj } from '@storybook/react';
import { VideoStateOverlay } from './video-state-overlay';

const meta = {
  title: 'Motion/VideoStateOverlay',
  component: VideoStateOverlay,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="relative aspect-video w-[640px]">
        {/* Mock poster frame background */}
        <div className="absolute inset-0 bg-linear-to-br from-purple-500 to-pink-500" />
        <div className="absolute inset-0 flex items-center justify-center text-white/20 text-6xl font-bold">
          POSTER FRAME
        </div>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof VideoStateOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const GeneratingShot: Story = {
  args: {
    thumbnailUrl: null,
    videoStatus: 'pending',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Shows when the shot (thumbnail) is still being generated. Video generation will start after shot is ready.',
      },
    },
  },
};

export const HasThumbnail: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'generating',
  },
  parameters: {
    docs: {
      description: {
        story:
          'No overlay when thumbnail exists - just shows the poster image while video generates.',
      },
    },
  },
};

export const Failed: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'failed',
  },
  parameters: {
    docs: {
      description: {
        story: 'Shows error state when video generation failed.',
      },
    },
  },
};

export const Completed: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'completed',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Completed status shows no overlay (returns null). Video will play normally.',
      },
    },
  },
};

export const ContentBlockedStill: Story = {
  args: {
    thumbnailUrl: null,
    videoStatus: 'pending',
    imageStatus: 'failed',
    imageError:
      'The content could not be processed because it contained material flagged by a content checker.',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Content-checker rejection on the still (#1272). Warning copy — edit the script or prompt, or retry — not a hard generation error.',
      },
    },
  },
};

export const RetryingImage: Story = {
  args: {
    thumbnailUrl: null,
    videoStatus: 'pending',
    retry: { attempt: 2 },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Image generation is retrying before any thumbnail exists (#882). The image side leans on CF’s default per-step retry budget (no fixed denominator), so the full loader reads a bare "Retrying…" — still distinguishable from a hung spinner.',
      },
    },
  },
};

export const RetryingVideo: Story = {
  args: {
    thumbnailUrl: 'https://example.com/image.jpg',
    videoStatus: 'generating',
    retry: { attempt: 3, maxAttempts: 3 },
  },
  parameters: {
    docs: {
      description: {
        story:
          'Video generation is retrying after the thumbnail already exists (#882). Surfaces as a small non-blocking badge over the still image, leaving the play button clear.',
      },
    },
  },
};
