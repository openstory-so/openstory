import type { Meta, StoryObj } from "@storybook/nextjs";
import { GenerationSection } from "../generation-section";

const meta: Meta<typeof GenerationSection> = {
  title: "Components/Sequence/GenerationSection",
  component: GenerationSection,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A section component containing the storyboard generation button with validation feedback.",
      },
    },
  },
  argTypes: {
    onGenerateStoryboard: {
      description: "Callback fired when generate button is clicked",
      action: "generate storyboard",
    },
    canGenerate: {
      description: "Whether the generate button should be enabled",
      control: "boolean",
    },
    isSubmitting: {
      description: "Whether the form is currently submitting",
      control: "boolean",
    },
    submitError: {
      description: "Error message from failed submission",
      control: "text",
    },
    validationRequirements: {
      description: "Object indicating which validation requirements are met",
      control: "object",
    },
  },
};

export default meta;
type Story = StoryObj<typeof GenerationSection>;

export const Ready: Story = {
  args: {
    canGenerate: true,
    isSubmitting: false,
    submitError: undefined,
    validationRequirements: {
      hasScript: true,
      hasStyle: true,
    },
  },
  parameters: {
    docs: {
      description: {
        story: "Generation section ready to generate storyboard.",
      },
    },
  },
};

export const Submitting: Story = {
  args: {
    canGenerate: false,
    isSubmitting: true,
    submitError: undefined,
    validationRequirements: {
      hasScript: true,
      hasStyle: true,
    },
  },
  parameters: {
    docs: {
      description: {
        story: "Generation section in submitting state with loading indicator.",
      },
    },
  },
};

export const MissingScript: Story = {
  args: {
    canGenerate: false,
    isSubmitting: false,
    submitError: undefined,
    validationRequirements: {
      hasScript: false,
      hasStyle: true,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Generation section showing validation help when script is missing.",
      },
    },
  },
};

export const MissingStyle: Story = {
  args: {
    canGenerate: false,
    isSubmitting: false,
    submitError: undefined,
    validationRequirements: {
      hasScript: true,
      hasStyle: false,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Generation section showing validation help when style is not selected.",
      },
    },
  },
};

export const MissingBoth: Story = {
  args: {
    canGenerate: false,
    isSubmitting: false,
    submitError: undefined,
    validationRequirements: {
      hasScript: false,
      hasStyle: false,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Generation section showing validation help when both script and style are missing.",
      },
    },
  },
};

export const WithError: Story = {
  args: {
    canGenerate: true,
    isSubmitting: false,
    submitError: "Failed to generate storyboard. Please try again.",
    validationRequirements: {
      hasScript: true,
      hasStyle: true,
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "Generation section displaying an error message after failed submission.",
      },
    },
  },
};
