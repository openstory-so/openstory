import { generateMockStyles } from '@/lib/mocks/data-generators';
import { DEFAULT_COMPOSER_STYLE_CATEGORY } from '@/lib/style/composer-style-row';
import { MOCK_SYSTEM_STYLES } from '@/lib/style/style-templates';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import { StyleSelector } from './style-selector';

const meta = {
  title: 'Style/StyleSelector',
  component: StyleSelector,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof StyleSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

const mockStyles = generateMockStyles(15);
const firstMockStyle = mockStyles[0];
if (!firstMockStyle) throw new Error('story setup: expected mock styles');

export const Default: Story = {
  args: {
    styles: mockStyles,
    selectedStyleId: firstMockStyle.id,
    onStyleSelect: fn(),
  },
  render: function RenderDefault() {
    const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
      firstMockStyle.id
    );

    return (
      <StyleSelector
        styles={mockStyles}
        selectedStyleId={selectedStyleId}
        onStyleSelect={setSelectedStyleId}
      />
    );
  },
};

const firstFilmStyle = MOCK_SYSTEM_STYLES.find(
  (style) => style.category === DEFAULT_COMPOSER_STYLE_CATEGORY
);
if (!firstFilmStyle) {
  throw new Error('story setup: expected a film style in MOCK_SYSTEM_STYLES');
}

export const CinematicRow: Story = {
  args: {
    styles: MOCK_SYSTEM_STYLES,
    selectedStyleId: firstFilmStyle.id,
    onStyleSelect: fn(),
    categoryFilter: DEFAULT_COMPOSER_STYLE_CATEGORY,
  },
  render: function RenderCinematicRow() {
    const [selectedStyleId, setSelectedStyleId] = useState<string | null>(
      firstFilmStyle.id
    );

    return (
      <StyleSelector
        styles={MOCK_SYSTEM_STYLES}
        selectedStyleId={selectedStyleId}
        onStyleSelect={setSelectedStyleId}
        categoryFilter={DEFAULT_COMPOSER_STYLE_CATEGORY}
      />
    );
  },
};
