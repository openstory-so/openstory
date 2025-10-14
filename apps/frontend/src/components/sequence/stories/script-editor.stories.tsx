import type { Meta, StoryObj } from "@storybook/nextjs";
import { useState } from "react";
import { ScriptEditor } from "../script-editor";

const meta: Meta<typeof ScriptEditor> = {
  title: "Components/Sequence/ScriptEditor",
  component: ScriptEditor,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A text editor component for writing video scripts with character counting, validation, and error handling.",
      },
    },
  },
  argTypes: {
    value: {
      description: "Current script content",
      control: "text",
    },
    onValueChange: {
      description: "Callback fired when the script content changes",
      action: "value changed",
    },
    error: {
      description: "Error message to display",
      control: "text",
    },
    maxLength: {
      description: "Maximum number of characters allowed",
      control: "number",
    },
    placeholder: {
      description: "Placeholder text when empty",
      control: "text",
    },
    disabled: {
      description: "Whether the editor is disabled",
      control: "boolean",
    },
    showCharacterCount: {
      description: "Whether to show character count",
      control: "boolean",
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptEditor>;

// Interactive wrapper component for stories that need state
function InteractiveScriptEditor(
  props: Omit<
    React.ComponentProps<typeof ScriptEditor>,
    "value" | "onValueChange"
  > & {
    initialValue?: string;
  },
) {
  const { initialValue = "", ...otherProps } = props;
  const [value, setValue] = useState(initialValue);

  return (
    <ScriptEditor value={value} onValueChange={setValue} {...otherProps} />
  );
}

export const Default: Story = {
  render: () => <InteractiveScriptEditor />,
};

export const WithContent: Story = {
  render: () => (
    <InteractiveScriptEditor
      initialValue="FADE IN:

EXT. COFFEE SHOP - DAY

A bustling street corner coffee shop with large windows overlooking the city. Steam rises from coffee cups as patrons hurry past.

SARAH (20s), a determined young writer, sits by the window with her laptop. She stares at the blank screen, fingers hovering over the keyboard.

SARAH
(to herself)
Come on, Sarah. Just write something. Anything.

The cursor blinks mockingly on the empty page. Sarah takes a deep breath and begins to type..."
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "ScriptEditor with existing script content showing character count and proper formatting.",
      },
    },
  },
};

export const WithError: Story = {
  render: () => (
    <InteractiveScriptEditor
      initialValue="Some script content"
      error="Script must be at least 100 characters long"
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "ScriptEditor displaying an error message with appropriate styling.",
      },
    },
  },
};

export const NearMaxLength: Story = {
  render: () => (
    <InteractiveScriptEditor initialValue={"A".repeat(4950)} maxLength={5000} />
  ),
  parameters: {
    docs: {
      description: {
        story: "ScriptEditor approaching the maximum character limit.",
      },
    },
  },
};

export const OverMaxLength: Story = {
  render: () => (
    <ScriptEditor
      value={"A".repeat(5100)}
      onValueChange={() => {}}
      maxLength={5000}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "ScriptEditor over the maximum character limit showing error styling.",
      },
    },
  },
};

export const Disabled: Story = {
  render: () => (
    <InteractiveScriptEditor
      initialValue="This script cannot be edited"
      disabled
    />
  ),
  parameters: {
    docs: {
      description: {
        story: "ScriptEditor in disabled state with existing content.",
      },
    },
  },
};

export const CustomPlaceholder: Story = {
  render: () => (
    <InteractiveScriptEditor placeholder="Start writing your screenplay here. Remember to include scene descriptions, character names, and dialogue..." />
  ),
  parameters: {
    docs: {
      description: {
        story: "ScriptEditor with custom placeholder text.",
      },
    },
  },
};

export const NoCharacterCount: Story = {
  render: () => (
    <InteractiveScriptEditor
      initialValue="Script without character count displayed"
      showCharacterCount={false}
    />
  ),
  parameters: {
    docs: {
      description: {
        story: "ScriptEditor with character count hidden.",
      },
    },
  },
};
