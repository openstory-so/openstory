import { useStyles } from '@/hooks/use-styles';
import { MOCK_SYSTEM_STYLES } from '@/lib/style/style-templates';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { StyleSelectionDialogWithTrigger } from './style-selection-dialog';
import { StyleSelectorButton } from './style-selector-button';

const meta: Meta<typeof StyleSelectorButton> = {
  title: 'Style/StyleSelectorButton',
  component: StyleSelectorButton,
  argTypes: {
    selectedStyle: {
      description: 'The currently selected style object',
      control: 'object',
    },
    onClick: {
      description: 'Callback fired when button is clicked',
      action: 'button clicked',
    },
    size: {
      description: 'Button size variant',
      control: 'select',
      options: ['sm', 'default', 'lg'],
    },
  },
};

export default meta;
type Story = StoryObj<typeof StyleSelectorButton>;

const firstMockStyle = MOCK_SYSTEM_STYLES[0];
if (!firstMockStyle) {
  throw new Error('story setup: expected MOCK_SYSTEM_STYLES to be non-empty');
}

export const NoSelection: Story = {
  args: {
    selectedStyle: null,
    size: 'default',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Button with no style selected shows placeholder text "Select Style"',
      },
    },
  },
};

export const WithSelection: Story = {
  args: {
    selectedStyle: MOCK_SYSTEM_STYLES[0],
    size: 'default',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Button showing selected style with name, category, and thumbnail preview',
      },
    },
  },
};

export const CinematicStyle: Story = {
  args: {
    selectedStyle:
      MOCK_SYSTEM_STYLES.find((s) => s.category === 'cinematic') ||
      MOCK_SYSTEM_STYLES[2],
    size: 'default',
  },
  parameters: {
    docs: {
      description: {
        story: 'Button with a cinematic style selected',
      },
    },
  },
};

export const SmallSize: Story = {
  args: {
    selectedStyle: MOCK_SYSTEM_STYLES[1],
    size: 'sm',
  },
  parameters: {
    docs: {
      description: {
        story: 'Compact button size for tight layouts',
      },
    },
  },
};

export const LargeSize: Story = {
  args: {
    selectedStyle: MOCK_SYSTEM_STYLES[3],
    size: 'lg',
  },
  parameters: {
    docs: {
      description: {
        story: 'Large button size for prominent placement',
      },
    },
  },
};

export const InteractiveButton: Story = {
  render: function RenderInteractiveButton() {
    const [clicks, setClicks] = useState(0);

    return (
      <div className="flex flex-col gap-4 p-8">
        <StyleSelectorButton
          selectedStyle={MOCK_SYSTEM_STYLES[0]}
          onClick={() => setClicks((c) => c + 1)}
        />
        <p className="text-sm text-muted-foreground">Clicked {clicks} times</p>
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story: 'Button with click interaction to demonstrate onClick handler',
      },
    },
  },
};

export const WithDialogIntegration: Story = {
  render: function RenderWithDialogIntegration() {
    const InteractiveDemo = () => {
      const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
        firstMockStyle.id
      );

      const { data: styles = [] } = useStyles();

      const selectedStyle =
        styles.find((s) => s.id === selectedStyleId) ||
        MOCK_SYSTEM_STYLES.find((s) => s.id === selectedStyleId);

      return (
        <div className="flex flex-col gap-4 p-8">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">
              Style Selector with Dialog Integration
            </h3>
            <p className="text-sm text-muted-foreground">
              Click the button to open the style selection dialog
            </p>
          </div>

          <StyleSelectionDialogWithTrigger
            styles={styles}
            selectedStyle={selectedStyle}
            onStyleSelect={setSelectedStyleId}
          />

          {selectedStyle && (
            <div className="mt-4 rounded-lg border p-4">
              <h4 className="font-medium">Current Selection:</h4>
              <p className="text-sm">{selectedStyle.name}</p>
              {selectedStyle.category && (
                <p className="text-xs text-muted-foreground">
                  {selectedStyle.category}
                </p>
              )}
            </div>
          )}
        </div>
      );
    };

    return <InteractiveDemo />;
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Complete integration example showing the button as a dialog trigger with state management',
      },
    },
  },
};

export const DifferentSizes: Story = {
  render: () => (
    <div className="flex flex-col gap-6 p-8">
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-muted-foreground">Small</h4>
        <StyleSelectorButton selectedStyle={MOCK_SYSTEM_STYLES[0]} size="sm" />
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-muted-foreground">Default</h4>
        <StyleSelectorButton
          selectedStyle={MOCK_SYSTEM_STYLES[1]}
          size="default"
        />
      </div>
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-muted-foreground">Large</h4>
        <StyleSelectorButton selectedStyle={MOCK_SYSTEM_STYLES[2]} size="lg" />
      </div>
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story: 'Comparison of all three button sizes',
      },
    },
  },
};

export const LongStyleName: Story = {
  args: {
    selectedStyle: {
      ...firstMockStyle,
      name: 'Ultra High Quality Cinematic Photography',
      category: 'Professional Cinematic',
    },
    size: 'default',
  },
  parameters: {
    docs: {
      description: {
        story: 'Button handling long style names and categories gracefully',
      },
    },
  },
};

export const WithoutThumbnail: Story = {
  args: {
    selectedStyle: {
      ...firstMockStyle,
      previewUrl: null,
    },
    size: 'default',
  },
  parameters: {
    docs: {
      description: {
        story: 'Button without a preview thumbnail (fallback state)',
      },
    },
  },
};

export const WithoutCategory: Story = {
  args: {
    selectedStyle: {
      ...firstMockStyle,
      category: null,
    },
    size: 'default',
  },
  parameters: {
    docs: {
      description: {
        story: 'Button without a category (shows only style name)',
      },
    },
  },
};
