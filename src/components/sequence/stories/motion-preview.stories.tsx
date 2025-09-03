import type { Meta, StoryObj } from "@storybook/nextjs";
import { generateMockFrame } from "@/lib/mocks/data-generators";
import { MotionPreview } from "../motion-preview";

const meta: Meta<typeof MotionPreview> = {
  title: "Sequence/MotionPreview",
  component: MotionPreview,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A video preview component with custom controls for the motion generation view.",
      },
    },
  },
  args: {
    onPlay: () => console.log("onPlay"),
    onPause: () => console.log("onPause"),
    onSeek: () => console.log("onSeek"),
    muted: true,
    autoPlay: false,
  },
  argTypes: {
    videoUrl: {
      description:
        "URL of the video file (optional - shows thumbnail fallback if not provided)",
    },
    thumbnailUrl: {
      description: "URL of the thumbnail image",
    },
    duration: {
      control: "number",
      description:
        "Expected duration in milliseconds (used for fallback when no video)",
    },
    frame: {
      description: "The frame data object",
    },
    autoPlay: {
      control: "boolean",
      description: "Whether to auto-play the video when loaded",
    },
    muted: {
      control: "boolean",
      description: "Whether to start muted (recommended for autoplay)",
    },
    loading: {
      control: "boolean",
      description: "Whether to show loading state",
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Mock frame data
const sampleFrame = generateMockFrame({
  id: "motion-frame-1",
  order_index: 1,
  description: "A cinematic establishing shot of a cityscape at golden hour",
  thumbnail_url: "https://picsum.photos/seed/1514565131-fce0801e5785/640/360",
  duration_ms: 5000,
});

// Sample video URLs from open sources
const sampleVideoUrl =
  "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

// Basic video preview
export const WithVideo: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
  },
};

// Thumbnail fallback (no video)
export const ThumbnailOnly: Story = {
  args: {
    // No videoUrl provided
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
  },
};

// Loading state
export const Loading: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
    loading: true,
  },
};

// Auto-play enabled (muted by default)
export const AutoPlay: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
    autoPlay: true,
    muted: true,
  },
  parameters: {
    // Skip autoplay test in CI due to browser limitations
    chromatic: { disableSnapshot: true },
    // Disable a11y checks for video autoplay to prevent timeouts
    a11y: { disable: true },
  },
};

// Unmuted version
export const Unmuted: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
    muted: false,
  },
};

// Different frame variations
export const Frame2: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      "https://picsum.photos/seed/1594736797933-d0501ba2fe65/640/360",
    duration: 8500,
    frame: generateMockFrame({
      id: "motion-frame-2",
      order_index: 2,
      description: "Close-up character dialogue scene",
      thumbnail_url:
        "https://picsum.photos/seed/1594736797933-d0501ba2fe65/640/360",
      duration_ms: 8500,
    }),
  },
};

export const Frame3: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl: "https://picsum.photos/seed/1553095066-5014bc7b7f2d/640/360",
    duration: 3200,
    frame: generateMockFrame({
      id: "motion-frame-3",
      order_index: 3,
      description: "Action sequence with dynamic movement",
      thumbnail_url:
        "https://picsum.photos/seed/1553095066-5014bc7b7f2d/640/360",
      duration_ms: 3200,
    }),
  },
};

// Long duration video
export const LongDuration: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      "https://picsum.photos/seed/1478720568477-152d9b164e26/640/360",
    duration: 15000,
    frame: generateMockFrame({
      id: "long-motion-frame",
      order_index: 5,
      description: "Extended scene with multiple story beats",
      thumbnail_url:
        "https://picsum.photos/seed/1478720568477-152d9b164e26/640/360",
      duration_ms: 15000,
    }),
  },
};

// Error states
export const ImageError: Story = {
  args: {
    // No videoUrl, broken thumbnail
    thumbnailUrl: "https://this-url-does-not-exist.com/broken.jpg",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
  },
};

// Multiple previews in a grid
const MultiplePreviewsTemplate: Story = {
  render: (args: React.ComponentProps<typeof MotionPreview>) => {
    const frames = [
      generateMockFrame({
        id: "multi-1",
        order_index: 1,
        description: "Opening landscape shot",
        thumbnail_url:
          "https://picsum.photos/seed/1506905925346-21bda4d32df4/640/360",
        duration_ms: 4000,
      }),
      generateMockFrame({
        id: "multi-2",
        order_index: 2,
        description: "Character introduction",
        thumbnail_url:
          "https://picsum.photos/seed/1507003211169-0a1dd7228f2d/640/360",
        duration_ms: 6000,
      }),
      generateMockFrame({
        id: "multi-3",
        order_index: 3,
        description: "Action sequence",
        thumbnail_url:
          "https://picsum.photos/seed/1536098561742-ca998e48cbcc/640/360",
        duration_ms: 3500,
      }),
      generateMockFrame({
        id: "multi-4",
        order_index: 4,
        description: "Dialogue scene",
        thumbnail_url:
          "https://picsum.photos/seed/1524712245354-2c4e5e7121c0/640/360",
        duration_ms: 8000,
      }),
    ];

    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 max-w-6xl">
        {frames.map((frame, index) => (
          <MotionPreview
            key={frame.id}
            {...args}
            // Every other frame has video, others are thumbnail-only
            videoUrl={index % 2 === 0 ? sampleVideoUrl : undefined}
            thumbnailUrl={
              frame.thumbnail_url ||
              "https://picsum.photos/seed/1536240478700-b869070f9279/640/360"
            }
            duration={frame.duration_ms || undefined}
            frame={frame}
          />
        ))}
      </div>
    );
  },
};

export const MultipleFrames: Story = {
  ...MultiplePreviewsTemplate,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        story:
          "Multiple motion previews showing mix of completed videos and thumbnail-only frames.",
      },
    },
  },
};

// Interactive story demonstrating keyboard shortcuts
export const Interactive: Story = {
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
  },
  parameters: {
    docs: {
      description: {
        story: `
Interactive video player with keyboard shortcuts:
- **Spacebar** or **K**: Play/Pause
- **M**: Toggle mute
- **F**: Toggle fullscreen
- **Click progress bar**: Seek to position
        `,
      },
    },
  },
};

// All loading states
export const LoadingStates: Story = {
  render: () => (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-6xl">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Video Loading</h3>
        <MotionPreview
          videoUrl={sampleVideoUrl}
          thumbnailUrl="https://picsum.photos/seed/1440404653325-ab127d49abc1/640/360"
          duration={5000}
          frame={generateMockFrame({ order_index: 1 })}
          loading={true}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">No Video</h3>
        <MotionPreview
          thumbnailUrl="https://picsum.photos/seed/1485846234645-a62644f84728/640/360"
          duration={5000}
          frame={generateMockFrame({ order_index: 2 })}
        />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Image Error</h3>
        <MotionPreview
          thumbnailUrl="https://broken-url.com/image.jpg"
          duration={5000}
          frame={generateMockFrame({ order_index: 3 })}
        />
      </div>
    </div>
  ),
  parameters: {
    layout: "padded",
  },
};

// Responsive demonstration
export const Responsive: Story = {
  render: (args: React.ComponentProps<typeof MotionPreview>) => (
    <div className="w-full space-y-4">
      <div className="w-full max-w-sm">
        <h3 className="mb-2 text-sm font-medium">Small (Mobile)</h3>
        <MotionPreview {...args} />
      </div>

      <div className="w-full max-w-md">
        <h3 className="mb-2 text-sm font-medium">Medium (Tablet)</h3>
        <MotionPreview {...args} />
      </div>

      <div className="w-full max-w-2xl">
        <h3 className="mb-2 text-sm font-medium">Large (Desktop)</h3>
        <MotionPreview {...args} />
      </div>
    </div>
  ),
  args: {
    videoUrl: sampleVideoUrl,
    thumbnailUrl:
      sampleFrame.thumbnail_url ||
      "https://picsum.photos/seed/1536240478700-b869070f9279/640/360",
    duration: sampleFrame.duration_ms || undefined,
    frame: sampleFrame,
  },
  parameters: {
    layout: "padded",
  },
};
