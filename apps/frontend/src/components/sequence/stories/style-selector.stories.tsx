import type { Meta, StoryObj } from "@storybook/nextjs";
import { useState } from "react";
import { stylePresets } from "@/lib/mocks/style-presets";
import { StyleSelector } from "../style-selector";

const meta: Meta<typeof StyleSelector> = {
  title: "Components/Sequence/StyleSelector",
  component: StyleSelector,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A component for selecting visual styles from a collection of style presets, displaying style previews with color palettes and metadata.",
      },
    },
  },
  argTypes: {
    selectedStyleId: {
      description: "ID of the currently selected style",
      control: "text",
    },
    onStyleSelect: {
      description: "Callback fired when a style is selected",
      action: "style selected",
    },
    styles: {
      description: "Array of available styles to choose from",
      control: false,
    },
    disabled: {
      description: "Whether the selector is disabled",
      control: "boolean",
    },
    loading: {
      description: "Whether to show loading skeleton",
      control: "boolean",
    },
  },
};

export default meta;
type Story = StoryObj<typeof StyleSelector>;

// Mock data - use predefined style presets for better visual examples
const mockStyles = stylePresets;

// Interactive wrapper for stories that need selection state
function InteractiveStyleSelector(
  props: Omit<
    React.ComponentProps<typeof StyleSelector>,
    "selectedStyleId" | "onStyleSelect"
  > & {
    initialSelectedId?: string | null;
  },
) {
  const { initialSelectedId = null, ...otherProps } = props;
  const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
    initialSelectedId,
  );

  return (
    <StyleSelector
      selectedStyleId={selectedStyleId}
      onStyleSelect={setSelectedStyleId}
      {...otherProps}
    />
  );
}

export const Default: Story = {
  render: () => <InteractiveStyleSelector styles={mockStyles} />,
};

export const WithSelection: Story = {
  render: () => (
    <InteractiveStyleSelector
      styles={mockStyles}
      initialSelectedId={mockStyles[2].id}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector with a pre-selected style showing visual feedback.",
      },
    },
  },
};

export const Loading: Story = {
  args: {
    styles: [],
    loading: true,
    selectedStyleId: null,
    onStyleSelect: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector showing loading skeletons while styles are being fetched.",
      },
    },
  },
};

export const EmptyState: Story = {
  args: {
    styles: [],
    loading: false,
    selectedStyleId: null,
    onStyleSelect: () => {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector showing empty state when no styles are available.",
      },
    },
  },
};

export const Disabled: Story = {
  render: () => (
    <InteractiveStyleSelector
      styles={stylePresets.slice(0, 6)}
      disabled
      initialSelectedId={stylePresets[1].id}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector in disabled state with reduced opacity and no interaction.",
      },
    },
  },
};

export const SmallCollection: Story = {
  render: () => <InteractiveStyleSelector styles={stylePresets.slice(0, 3)} />,
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector with only a few styles, showing responsive grid behavior.",
      },
    },
  },
};

export const LargeCollection: Story = {
  render: () => (
    <InteractiveStyleSelector
      styles={[
        ...stylePresets,
        ...stylePresets.map((s) => ({
          ...s,
          id: `${s.id}-2`,
          name: `${s.name} v2`,
        })),
      ]}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector with many styles demonstrating scrollable grid layout.",
      },
    },
  },
};

export const ResponsiveLayout: Story = {
  render: () => (
    <div className="max-w-7xl mx-auto">
      <InteractiveStyleSelector styles={mockStyles} />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "StyleSelector demonstrating responsive grid layout behavior at different screen sizes.",
      },
    },
    viewport: {
      viewports: {
        mobile: { name: "Mobile", styles: { width: "375px", height: "667px" } },
        tablet: {
          name: "Tablet",
          styles: { width: "768px", height: "1024px" },
        },
        desktop: {
          name: "Desktop",
          styles: { width: "1440px", height: "900px" },
        },
      },
    },
  },
};

export const StyleCategories: Story = {
  render: () => (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-medium mb-4">Cinematic Styles</h3>
        <InteractiveStyleSelector
          styles={stylePresets.filter((s) =>
            [
              "style-cinematic",
              "style-noir",
              "style-documentary",
              "style-horror",
            ].includes(s.id),
          )}
        />
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4">Artistic Styles</h3>
        <InteractiveStyleSelector
          styles={stylePresets.filter((s) =>
            [
              "style-watercolor",
              "style-oil-painting",
              "style-minimalist",
            ].includes(s.id),
          )}
        />
      </div>

      <div>
        <h3 className="text-lg font-medium mb-4">Modern & Stylized</h3>
        <InteractiveStyleSelector
          styles={stylePresets.filter((s) =>
            [
              "style-anime",
              "style-cyberpunk",
              "style-retro",
              "style-comic",
              "style-fantasy",
            ].includes(s.id),
          )}
        />
      </div>
    </div>
  ),
  parameters: {
    layout: "padded",
    docs: {
      description: {
        story:
          "StyleSelector organized by categories, showing different visual style groups for video generation.",
      },
    },
  },
};

export const PopularStyles: Story = {
  render: () => (
    <div className="space-y-4">
      <div className="mb-4">
        <h2 className="text-xl font-semibold mb-2">Popular Styles</h2>
        <p className="text-muted-foreground">
          Most used styles by our community
        </p>
      </div>
      <InteractiveStyleSelector
        styles={[
          "style-cinematic",
          "style-anime",
          "style-cyberpunk",
          "style-watercolor",
          "style-minimalist",
          "style-comic",
        ]
          .map((id) => stylePresets.find((s) => s.id === id))
          .filter((s): s is NonNullable<typeof s> => s !== undefined)}
        initialSelectedId="style-cinematic"
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          "A curated selection of the most popular styles, pre-selected with Cinematic Epic.",
      },
    },
  },
};
