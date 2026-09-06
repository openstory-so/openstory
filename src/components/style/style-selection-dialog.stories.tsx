import { Button } from '@/components/ui/button';
import { useStyles } from '@/hooks/use-styles';
import { MOCK_SYSTEM_STYLES } from '@/lib/style/style-templates';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import {
  StyleSelectionDialog,
  StyleSelectionDialogWithTrigger,
} from './style-selection-dialog';

const meta: Meta<typeof StyleSelectionDialog> = {
  title: 'Style/StyleSelectionDialog',
  component: StyleSelectionDialog,
  parameters: {
    layout: 'centered',
    docs: {
      description: {
        component:
          'A full-featured dialog for browsing and selecting visual styles with search, category filters, and responsive grid layout.',
      },
    },
  },
  argTypes: {
    open: {
      description: 'Whether the dialog is open',
      control: 'boolean',
    },
    onOpenChange: {
      description: 'Callback fired when dialog open state changes',
      action: 'dialog state changed',
    },
    onStyleSelect: {
      description: 'Callback fired when a style is selected',
      action: 'style selected',
    },
  },
};

export default meta;
type Story = StoryObj<typeof StyleSelectionDialog>;

const mockStyle0 = MOCK_SYSTEM_STYLES[0];
const mockStyle1 = MOCK_SYSTEM_STYLES[1];
const mockStyle2 = MOCK_SYSTEM_STYLES[2];
if (!mockStyle0 || !mockStyle1 || !mockStyle2) {
  throw new Error(
    'story setup: expected MOCK_SYSTEM_STYLES to have at least 3 entries'
  );
}

// Interactive wrapper for stories
function InteractiveStyleDialog(
  props: Partial<React.ComponentProps<typeof StyleSelectionDialog>>
) {
  const [open, setOpen] = useState(true);
  const [, setSelectedStyleId] = useState<string | null>(null);

  const { data: styles = [] } = useStyles();

  return (
    <div className="flex flex-col gap-4">
      {!open && (
        <Button onClick={() => setOpen(true)}>Open Visual Style Dialog</Button>
      )}
      <StyleSelectionDialog
        open={open}
        onOpenChange={setOpen}
        styles={styles}
        onStyleSelect={setSelectedStyleId}
        {...props}
      />
    </div>
  );
}

export const Default: Story = {
  render: () => <InteractiveStyleDialog />,
  parameters: {
    docs: {
      description: {
        story:
          'Default style selection dialog with search, category filters, and style grid. Click on any style to select it.',
      },
    },
  },
};

export const WithPreselection: Story = {
  render: () => <InteractiveStyleDialog />,
  parameters: {
    docs: {
      description: {
        story: 'Dialog opened over the category-grouped browse view.',
      },
    },
  },
};

export const EmptyState: Story = {
  render: () => {
    const EmptyWrapper = () => {
      const [open, setOpen] = useState(true);
      const [, setSelectedStyleId] = useState<string | null>(null);

      return (
        <div>
          {!open && <Button onClick={() => setOpen(true)}>Reopen</Button>}
          <StyleSelectionDialog
            open={open}
            onOpenChange={setOpen}
            onStyleSelect={setSelectedStyleId}
          />
        </div>
      );
    };

    return <EmptyWrapper />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Dialog showing empty state when no styles match the current search/filter criteria.',
      },
    },
  },
};

export const SearchFunctionality: Story = {
  render: () => <InteractiveStyleDialog />,
  parameters: {
    docs: {
      description: {
        story:
          'Demonstrates the search functionality. Try searching for "cinematic", "anime", or "watercolor" to filter styles.',
      },
    },
  },
};

export const CategoryFilters: Story = {
  render: () => <InteractiveStyleDialog />,
  parameters: {
    docs: {
      description: {
        story:
          'Shows the category filter chips. Click different categories to filter styles (All, New, TikTok Core, etc.).',
      },
    },
  },
};

export const MobileView: Story = {
  render: () => <InteractiveStyleDialog />,

  parameters: {
    docs: {
      description: {
        story:
          'Dialog optimized for mobile devices with responsive grid layout (2 columns on small screens).',
      },
    },
  },

  globals: {
    viewport: {
      value: 'mobile1',
      isRotated: false,
    },
  },
};

export const TabletView: Story = {
  render: () => <InteractiveStyleDialog />,

  parameters: {
    docs: {
      description: {
        story: 'Dialog on tablet-sized screens showing 3-4 column grid layout.',
      },
    },
  },

  globals: {
    viewport: {
      value: 'tablet',
      isRotated: false,
    },
  },
};

export const DesktopView: Story = {
  render: () => <InteractiveStyleDialog />,

  parameters: {
    docs: {
      description: {
        story:
          'Full desktop view with 5-column grid layout for browsing many styles.',
      },
    },
  },

  globals: {
    viewport: {
      value: 'desktop',
      isRotated: false,
    },
  },
};

export const InteractionFlow: Story = {
  render: () => {
    const InteractionDemo = () => {
      const [open, setOpen] = useState(false);
      const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
        null
      );

      const selectedStyle = MOCK_SYSTEM_STYLES.find(
        (style) => style.id === selectedStyleId
      );

      return (
        <div className="flex flex-col gap-4 p-8">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">Current Selection:</h3>
            {selectedStyle ? (
              <div className="p-4 border rounded-lg">
                <p className="font-medium">{selectedStyle.name}</p>
                {typeof selectedStyle.config === 'object' &&
                'artStyle' in selectedStyle.config ? (
                  <p className="text-sm text-muted-foreground">
                    {String(selectedStyle.config.artStyle)}
                  </p>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground">No style selected</p>
            )}
          </div>

          <Button onClick={() => setOpen(true)}>Choose Visual Style</Button>

          <StyleSelectionDialog
            open={open}
            onOpenChange={setOpen}
            onStyleSelect={setSelectedStyleId}
          />
        </div>
      );
    };

    return <InteractionDemo />;
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Complete interaction flow showing how to trigger the dialog with a button and display the selected style.',
      },
    },
  },
};

export const KeyboardNavigation: Story = {
  render: () => <InteractiveStyleDialog />,
  parameters: {
    docs: {
      description: {
        story:
          'Dialog with full keyboard navigation support. Use Tab to navigate between styles, Enter/Space to select, and Escape to close.',
      },
    },
  },
};

export const LoadingState: Story = {
  render: () => {
    const LoadingWrapper = () => {
      const [open, setOpen] = useState(true);

      return (
        <div>
          {!open && <Button onClick={() => setOpen(true)}>Reopen</Button>}
          <StyleSelectionDialog
            open={open}
            onOpenChange={setOpen}
            onStyleSelect={() => {}}
          />
        </div>
      );
    };

    return <LoadingWrapper />;
  },
  parameters: {
    docs: {
      description: {
        story:
          'Dialog showing loading skeletons while styles are being fetched from the API.',
      },
    },
  },
};

export const WithSelectorButton: Story = {
  render: () => {
    const SelectorButtonDemo = () => {
      const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
        mockStyle0.id
      );

      const { data: styles = [] } = useStyles();

      const selectedStyle =
        styles.find((s) => s.id === selectedStyleId) ||
        MOCK_SYSTEM_STYLES.find((s) => s.id === selectedStyleId);

      return (
        <div className="flex flex-col gap-6 p-8">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">
              Style Selector Button Integration
            </h3>
            <p className="text-sm text-muted-foreground">
              Click the button below to open the style selection dialog. The
              button shows the currently selected style with a thumbnail
              background.
            </p>
          </div>

          <StyleSelectionDialogWithTrigger
            styles={styles}
            selectedStyle={selectedStyle}
            onStyleSelect={setSelectedStyleId}
          />

          {selectedStyle && (
            <div className="mt-2 rounded-lg border bg-card p-4">
              <h4 className="font-medium">Currently Selected:</h4>
              <p className="text-sm text-muted-foreground">
                {selectedStyle.name}
              </p>
              {selectedStyle.category && (
                <p className="text-xs text-muted-foreground">
                  Category: {selectedStyle.category}
                </p>
              )}
            </div>
          )}
        </div>
      );
    };

    return <SelectorButtonDemo />;
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Shows the new style selector button component as a dialog trigger. The button displays the selected style with a thumbnail background and opens the full selection dialog when clicked.',
      },
    },
  },
};

export const SelectorButtonSizes: Story = {
  render: () => {
    const SizeDemo = () => {
      const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
        mockStyle1.id
      );

      const { data: styles = [] } = useStyles();

      const selectedStyle =
        styles.find((s) => s.id === selectedStyleId) ||
        MOCK_SYSTEM_STYLES.find((s) => s.id === selectedStyleId);

      return (
        <div className="flex flex-col gap-8 p-8">
          <div className="space-y-4">
            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                Small Size
              </h4>
              <StyleSelectionDialogWithTrigger
                styles={styles}
                selectedStyle={selectedStyle}
                onStyleSelect={setSelectedStyleId}
                buttonSize="sm"
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                Default Size
              </h4>
              <StyleSelectionDialogWithTrigger
                styles={styles}
                selectedStyle={selectedStyle}
                onStyleSelect={setSelectedStyleId}
                buttonSize="default"
              />
            </div>

            <div>
              <h4 className="mb-2 text-sm font-medium text-muted-foreground">
                Large Size
              </h4>
              <StyleSelectionDialogWithTrigger
                styles={styles}
                selectedStyle={selectedStyle}
                onStyleSelect={setSelectedStyleId}
                buttonSize="lg"
              />
            </div>
          </div>
        </div>
      );
    };

    return <SizeDemo />;
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Demonstrates the three available button sizes (small, default, large) with the style selector button trigger.',
      },
    },
  },
};

export const SelectorButtonNoSelection: Story = {
  render: () => {
    const NoSelectionDemo = () => {
      const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
        null
      );

      const { data: styles = [] } = useStyles();

      const selectedStyle = selectedStyleId
        ? styles.find((s) => s.id === selectedStyleId) ||
          MOCK_SYSTEM_STYLES.find((s) => s.id === selectedStyleId)
        : null;

      return (
        <div className="flex flex-col gap-6 p-8">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">No Style Selected</h3>
            <p className="text-sm text-muted-foreground">
              When no style is selected, the button shows placeholder text
              "Select Style".
            </p>
          </div>

          <StyleSelectionDialogWithTrigger
            styles={styles}
            selectedStyle={selectedStyle}
            onStyleSelect={setSelectedStyleId}
          />

          {selectedStyle && (
            <div className="mt-2 rounded-lg border bg-card p-4">
              <h4 className="font-medium">You selected:</h4>
              <p className="text-sm text-muted-foreground">
                {selectedStyle.name}
              </p>
            </div>
          )}
        </div>
      );
    };

    return <NoSelectionDemo />;
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Shows the selector button in its initial state when no style has been selected yet.',
      },
    },
  },
};

export const CustomTrigger: Story = {
  render: () => {
    const CustomTriggerDemo = () => {
      const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
        mockStyle2.id
      );

      const { data: styles = [] } = useStyles();

      const selectedStyle =
        styles.find((s) => s.id === selectedStyleId) ||
        MOCK_SYSTEM_STYLES.find((s) => s.id === selectedStyleId);

      return (
        <div className="flex flex-col gap-6 p-8">
          <div className="space-y-2">
            <h3 className="text-lg font-semibold">Custom Trigger Button</h3>
            <p className="text-sm text-muted-foreground">
              You can provide your own custom trigger element instead of using
              the default selector button.
            </p>
          </div>

          <div className="flex gap-4">
            <StyleSelectionDialogWithTrigger
              styles={styles}
              selectedStyle={selectedStyle}
              onStyleSelect={setSelectedStyleId}
              trigger={<Button variant="default">Choose Visual Style</Button>}
            />

            <StyleSelectionDialogWithTrigger
              styles={styles}
              selectedStyle={selectedStyle}
              onStyleSelect={setSelectedStyleId}
              trigger={<Button variant="outline">Change Style</Button>}
            />
          </div>

          {selectedStyle && (
            <div className="mt-2 rounded-lg border bg-card p-4">
              <h4 className="font-medium">Currently Selected:</h4>
              <p className="text-sm">{selectedStyle.name}</p>
            </div>
          )}
        </div>
      );
    };

    return <CustomTriggerDemo />;
  },
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        story:
          'Demonstrates how to use custom trigger elements with the StyleSelectionDialogWithTrigger component.',
      },
    },
  },
};
