import type { Meta, StoryObj } from "@storybook/nextjs";
import type { Style } from "@/types/database";
import { StyleSection } from "../style-section";

// Mock styles data for stories
const mockStyles: Style[] = [
  {
    id: "style-1",
    name: "Cinematic Drama",
    preview_url:
      "https://picsum.photos/seed/1440404653325-ab127d49abc1/400/300",
    config: {
      artStyle: "Cinematic",
      colorPalette: ["#1a1a1a", "#d4af37", "#8b4513", "#2c2c2c"],
    },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    created_by: null,
    is_public: false,
    team_id: "team-1",
    category: null,
    description: null,
    is_template: null,
    parent_id: null,
    tags: null,
    usage_count: null,
    version: null,
  },
  {
    id: "style-2",
    name: "Animated Adventure",
    preview_url:
      "https://picsum.photos/seed/1578662996442-48f60103fc96/400/300",
    config: {
      artStyle: "Animation",
      colorPalette: ["#ff6b35", "#f7931e", "#1f4e79", "#85c7de"],
    },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    created_by: null,
    is_public: false,
    team_id: "team-1",
    category: null,
    description: null,
    is_template: null,
    parent_id: null,
    tags: null,
    usage_count: null,
    version: null,
  },
  {
    id: "style-3",
    name: "Film Noir",
    preview_url:
      "https://picsum.photos/seed/1485846234645-a62644f84728/400/300",
    config: {
      artStyle: "Film Noir",
      colorPalette: ["#000000", "#ffffff", "#404040", "#808080"],
    },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
    created_by: null,
    is_public: false,
    team_id: "team-1",
    category: null,
    description: null,
    is_template: null,
    parent_id: null,
    tags: null,
    usage_count: null,
    version: null,
  },
];

const meta: Meta<typeof StyleSection> = {
  title: "Components/Sequence/StyleSection",
  component: StyleSection,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A section component containing the style selector with title and description.",
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
      description: "Array of available styles",
      control: "object",
    },
    loading: {
      description: "Whether styles are currently loading",
      control: "boolean",
    },
    error: {
      description: "Whether there was an error loading styles",
      control: "boolean",
    },
    disabled: {
      description: "Whether the style selector is disabled",
      control: "boolean",
    },
  },
};

export default meta;
type Story = StoryObj<typeof StyleSection>;

export const StyleSectionWithStyles: Story = {
  args: {
    selectedStyleId: null,
    styles: mockStyles,
    loading: false,
    error: false,
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Style section with available styles to choose from.",
      },
    },
  },
};

export const StyleSectionWithSelectedStyle: Story = {
  args: {
    selectedStyleId: "style-2",
    styles: mockStyles,
    loading: false,
    error: false,
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Style section with a pre-selected style.",
      },
    },
  },
};

export const StyleSectionLoading: Story = {
  args: {
    selectedStyleId: null,
    styles: [],
    loading: true,
    error: false,
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Style section in loading state showing skeleton placeholders.",
      },
    },
  },
};

export const StyleSectionError: Story = {
  args: {
    selectedStyleId: null,
    styles: [],
    loading: false,
    error: true,
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Style section showing an error state when styles fail to load.",
      },
    },
  },
};

export const StyleSectionEmpty: Story = {
  args: {
    selectedStyleId: null,
    styles: [],
    loading: false,
    error: false,
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        story: "Style section with no available styles.",
      },
    },
  },
};

export const StyleSectionDisabled: Story = {
  args: {
    selectedStyleId: "style-1",
    styles: mockStyles,
    loading: false,
    error: false,
    disabled: true,
  },
  parameters: {
    docs: {
      description: {
        story: "Style section in disabled state during form submission.",
      },
    },
  },
};
