import type { Meta, StoryObj } from "@storybook/nextjs";
import { ProgressSection } from "../progress-section";

const meta: Meta<typeof ProgressSection> = {
  title: "Components/Sequence/ProgressSection",
  component: ProgressSection,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A visual progress indicator showing completion status of sequence setup steps.",
      },
    },
  },
  argTypes: {
    progress: {
      description: "Progress data including completion counts and percentage",
      control: "object",
    },
  },
};

export default meta;
type Story = StoryObj<typeof ProgressSection>;

export const Empty: Story = {
  args: {
    progress: {
      completed: 0,
      total: 2,
      percentage: 0,
    },
  },
  parameters: {
    docs: {
      description: {
        story: "Progress section showing no completed steps.",
      },
    },
  },
};

export const HalfComplete: Story = {
  args: {
    progress: {
      completed: 1,
      total: 2,
      percentage: 50,
    },
  },
  parameters: {
    docs: {
      description: {
        story: "Progress section showing one of two steps completed.",
      },
    },
  },
};

export const Complete: Story = {
  args: {
    progress: {
      completed: 2,
      total: 2,
      percentage: 100,
    },
  },
  parameters: {
    docs: {
      description: {
        story: "Progress section showing all steps completed.",
      },
    },
  },
};

export const MultipleSteps: Story = {
  args: {
    progress: {
      completed: 3,
      total: 5,
      percentage: 60,
    },
  },
  parameters: {
    docs: {
      description: {
        story: "Progress section with multiple steps (3 of 5 completed).",
      },
    },
  },
};
