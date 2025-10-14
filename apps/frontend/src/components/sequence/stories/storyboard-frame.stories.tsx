import { closestCenter, DndContext } from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Meta, StoryObj } from "@storybook/nextjs";
import { generateMockFrame } from "@/lib/mocks/data-generators";
import { StoryboardFrame } from "../storyboard-frame";

const meta: Meta<typeof StoryboardFrame> = {
  title: "Sequence/StoryboardFrame",
  component: StoryboardFrame,
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "A frame component for the storyboard view with drag & drop, selection, and action buttons.",
      },
    },
  },
  args: {
    onSelect: () => console.log("onSelect"),
    onEdit: () => console.log("onEdit"),
    onDelete: () => console.log("onDelete"),
    onReorder: () => console.log("onReorder"),
  },
  argTypes: {
    frame: {
      description: "The frame data to display",
    },
    selected: {
      control: "boolean",
      description: "Whether the frame is currently selected",
    },
    disabled: {
      control: "boolean",
      description: "Whether the frame interactions are disabled",
    },
    showOrder: {
      control: "boolean",
      description: "Whether to show the order indicator and drag handle",
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Mock frame data
const sampleFrame = generateMockFrame({
  id: "frame-1",
  order_index: 1,
  description:
    "A hero shot of the main character standing on a cliff overlooking the ocean at sunset. The warm golden light illuminates their face as they contemplate their next move.",
  thumbnail_url:
    "https://picsum.photos/seed/1506905925346-21bda4d32df4/400/225",
  duration_ms: 5000,
});

const frameWithVideo = generateMockFrame({
  id: "frame-2",
  order_index: 2,
  description:
    "Close-up of hands typing rapidly on a keyboard in a dimly lit room.",
  thumbnail_url:
    "https://picsum.photos/seed/1515378791036-0648a3ef77b2/400/225",
  video_url: "https://example.com/video.mp4",
  duration_ms: 3500,
});

const longDescriptionFrame = generateMockFrame({
  id: "frame-3",
  order_index: 3,
  description:
    "An extremely long description that should be truncated when displayed in the component. This text goes on and on to demonstrate how the component handles overflow text by adding ellipsis after a certain character limit to maintain clean visual appearance.",
  thumbnail_url: "https://picsum.photos/seed/1550745165-9bc0b252726f/400/225",
  duration_ms: 7500,
});

// Basic frame story
export const Default: Story = {
  args: {
    frame: sampleFrame,
  },
};

// Selected state
export const Selected: Story = {
  args: {
    frame: sampleFrame,
    selected: true,
  },
};

// Frame with video/motion generated
export const WithVideo: Story = {
  args: {
    frame: frameWithVideo,
  },
};

// Disabled state
export const Disabled: Story = {
  args: {
    frame: sampleFrame,
    disabled: true,
  },
};

// Without order indicator
export const WithoutOrder: Story = {
  args: {
    frame: sampleFrame,
    showOrder: false,
  },
};

// Long description (truncated)
export const LongDescription: Story = {
  args: {
    frame: longDescriptionFrame,
  },
};

// Interactive states demonstration
export const Interactive: Story = {
  args: {
    frame: sampleFrame,
  },
  play: async () => {
    // This story demonstrates interactions but cannot simulate all hover states in Storybook
    // In real usage, hover states would show action buttons
  },
};

// Drag and drop context for multiple frames
const MultipleFramesTemplate: Story = {
  render: (args: React.ComponentProps<typeof StoryboardFrame>) => {
    const frames = [
      generateMockFrame({
        id: "frame-1",
        order_index: 1,
        description: "Opening scene with dramatic landscape",
        thumbnail_url:
          "https://picsum.photos/seed/1519904981063-b0cf448d479e/400/225",
      }),
      generateMockFrame({
        id: "frame-2",
        order_index: 2,
        description: "Character introduction with close-up shot",
        thumbnail_url:
          "https://picsum.photos/seed/1507003211169-0a1dd7228f2d/400/225",
        video_url: "https://example.com/video2.mp4",
      }),
      generateMockFrame({
        id: "frame-3",
        order_index: 3,
        description: "Action sequence in urban environment",
        thumbnail_url:
          "https://picsum.photos/seed/1536098561742-ca998e48cbcc/400/225",
      }),
    ];

    return (
      <DndContext collisionDetection={closestCenter}>
        <SortableContext
          items={frames.map((f) => f.id)}
          strategy={verticalListSortingStrategy}
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 max-w-4xl">
            {frames.map((frame, index) => (
              <StoryboardFrame
                key={frame.id}
                {...args}
                frame={frame}
                selected={index === 1} // Select the middle frame
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    );
  },
};

export const MultipleFrames: Story = {
  ...MultipleFramesTemplate,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        story:
          "Multiple frames in a draggable context, demonstrating the typical storyboard grid layout.",
      },
    },
  },
};

// Loading states
export const LoadingImage: Story = {
  args: {
    frame: {
      ...sampleFrame,
      thumbnail_url: "https://httpstat.us/500", // This will cause loading state
    },
  },
};

// Error state (broken image)
export const ImageError: Story = {
  args: {
    frame: {
      ...sampleFrame,
      thumbnail_url: "https://this-url-does-not-exist.com/image.jpg",
    },
  },
};

// Different aspect ratios and content
export const PortraitImage: Story = {
  args: {
    frame: generateMockFrame({
      id: "portrait-frame",
      order_index: 5,
      description: "Portrait orientation shot for mobile-first content",
      thumbnail_url:
        "https://picsum.photos/seed/1544005313-94ddf0286df2/400/600",
    }),
  },
};

// Minimal frame data
export const MinimalData: Story = {
  args: {
    frame: generateMockFrame({
      id: "minimal-frame",
      order_index: 1,
      description: "Basic frame",
      thumbnail_url:
        "https://picsum.photos/seed/1485846234645-a62644f84728/400/225",
      duration_ms: undefined, // No duration
    }),
  },
};
