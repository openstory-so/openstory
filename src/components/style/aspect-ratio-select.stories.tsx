import type { Meta, StoryObj } from '@storybook/react';

import type { AspectRatio } from '@/shared/constants/aspect-ratios';
import { useState } from 'react';
import { AspectRatioSelect } from './aspect-ratio-select';

const meta: Meta<typeof AspectRatioSelect> = {
  title: 'Style/AspectRatioSelect',
  component: AspectRatioSelect,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof AspectRatioSelect>;

export const Default: Story = {
  render: function RenderDefault() {
    const [value, setValue] = useState<AspectRatio | undefined>();
    return (
      <AspectRatioSelect
        value={value}
        onChange={setValue}
        placeholder="Select aspect ratio"
      />
    );
  },
};

export const Selected: Story = {
  render: function RenderSelected() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return <AspectRatioSelect value={value} onChange={setValue} />;
  },
};

export const Disabled: Story = {
  render: function RenderDisabled() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return <AspectRatioSelect value={value} onChange={setValue} disabled />;
  },
};

export const SmallSize: Story = {
  render: function RenderSmallSize() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return <AspectRatioSelect value={value} onChange={setValue} size="sm" />;
  },
};

export const LargeSize: Story = {
  render: function RenderLargeSize() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return <AspectRatioSelect value={value} onChange={setValue} size="lg" />;
  },
};

export const SizeComparison: Story = {
  render: function RenderSizeComparison() {
    const [valueSm, setValueSm] = useState<AspectRatio>('16:9');
    const [valueDefault, setValueDefault] = useState<AspectRatio>('9:16');
    const [valueLg, setValueLg] = useState<AspectRatio>('1:1');

    return (
      <div className="flex flex-col gap-6">
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">Small</h4>
          <AspectRatioSelect value={valueSm} onChange={setValueSm} size="sm" />
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">Default</h4>
          <AspectRatioSelect
            value={valueDefault}
            onChange={setValueDefault}
            size="default"
          />
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">Large</h4>
          <AspectRatioSelect value={valueLg} onChange={setValueLg} size="lg" />
        </div>
      </div>
    );
  },
};

export const Vertical: Story = {
  render: function RenderVertical() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return (
      <AspectRatioSelect value={value} onChange={setValue} variant="vertical" />
    );
  },
};

export const VerticalSmall: Story = {
  render: function RenderVerticalSmall() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return (
      <AspectRatioSelect
        value={value}
        onChange={setValue}
        variant="vertical"
        size="sm"
      />
    );
  },
};

export const VerticalLarge: Story = {
  render: function RenderVerticalLarge() {
    const [value, setValue] = useState<AspectRatio>('16:9');
    return (
      <AspectRatioSelect
        value={value}
        onChange={setValue}
        variant="vertical"
        size="lg"
      />
    );
  },
};

export const VariantComparison: Story = {
  render: function RenderVariantComparison() {
    const [valueHorizontal, setValueHorizontal] = useState<AspectRatio>('16:9');
    const [valueVertical, setValueVertical] = useState<AspectRatio>('9:16');

    return (
      <div className="flex gap-6">
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">
            Horizontal
          </h4>
          <AspectRatioSelect
            value={valueHorizontal}
            onChange={setValueHorizontal}
            variant="horizontal"
          />
        </div>
        <div className="space-y-2">
          <h4 className="text-sm font-medium text-muted-foreground">
            Vertical
          </h4>
          <AspectRatioSelect
            value={valueVertical}
            onChange={setValueVertical}
            variant="vertical"
          />
        </div>
      </div>
    );
  },
};

export const Interactive: Story = {
  render: function RenderInteractive() {
    const [selectedRatio, setSelectedRatio] = useState<AspectRatio | undefined>(
      '16:9'
    );

    return (
      <div className="flex flex-col gap-4 w-80">
        <AspectRatioSelect value={selectedRatio} onChange={setSelectedRatio} />
        <div className="rounded-lg border bg-muted p-4">
          <p className="text-sm font-medium">Current Selection:</p>
          <p className="text-lg">
            {selectedRatio || (
              <span className="text-muted-foreground">None</span>
            )}
          </p>
        </div>
      </div>
    );
  },
};
