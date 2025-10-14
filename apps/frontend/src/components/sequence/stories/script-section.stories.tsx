import type { Meta, StoryObj } from "@storybook/nextjs";
import { ScriptSection } from "../script-section";

const meta: Meta<typeof ScriptSection> = {
  title: "Components/Sequence/ScriptSection",
  component: ScriptSection,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A section component containing the script editor with title and description.",
      },
    },
  },
  argTypes: {
    script: {
      description: "Current script content",
      control: "text",
    },
    onScriptChange: {
      description: "Callback fired when script content changes",
      action: "script changed",
    },
    error: {
      description: "Error message to display",
      control: "text",
    },
    disabled: {
      description: "Whether the script editor is disabled",
      control: "boolean",
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptSection>;

export const Empty: Story = {
  args: {
    script: "",
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Script section with no content.",
      },
    },
  },
};

export const WithContent: Story = {
  args: {
    script: `FADE IN:

EXT. COFFEE SHOP - DAY

A bustling street corner with people walking by. SARAH, a young writer, sits by the window with her laptop, occasionally glancing up at the passersby.

SARAH types furiously, then pauses to take a sip of her coffee.

SARAH
(to herself)
This has to be perfect.

The camera slowly zooms in on her laptop screen, revealing the opening lines of a screenplay.`,
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Script section with sample script content.",
      },
    },
  },
};

export const WithError: Story = {
  args: {
    script: "Too short",
    error: "Script must be at least 10 characters long",
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Script section displaying a validation error.",
      },
    },
  },
};

export const Disabled: Story = {
  args: {
    script: "This script cannot be edited",
    disabled: true,
  },
  parameters: {
    docs: {
      description: {
        story: "Script section in disabled state during submission.",
      },
    },
  },
};
