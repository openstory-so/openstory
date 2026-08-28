import { MOCK_SYSTEM_STYLES } from '@/lib/style/style-templates';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { DEFAULT_COMPOSER_STYLE_CATEGORY } from '@/lib/style/composer-style-row';
import { StyleCategorySelect } from './style-category-select';

const meta: Meta<typeof StyleCategorySelect> = {
  title: 'Style/StyleCategorySelect',
  component: StyleCategorySelect,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof StyleCategorySelect>;

export const Default: Story = {
  render: function RenderDefault() {
    const [value, setValue] = useState(DEFAULT_COMPOSER_STYLE_CATEGORY);
    return (
      <StyleCategorySelect
        styles={MOCK_SYSTEM_STYLES}
        value={value}
        onChange={setValue}
      />
    );
  },
};

export const AllStyles: Story = {
  render: function RenderAllStyles() {
    const [value, setValue] = useState('all');
    return (
      <StyleCategorySelect
        styles={MOCK_SYSTEM_STYLES}
        value={value}
        onChange={setValue}
      />
    );
  },
};

export const Disabled: Story = {
  render: function RenderDisabled() {
    return (
      <StyleCategorySelect
        styles={MOCK_SYSTEM_STYLES}
        value={DEFAULT_COMPOSER_STYLE_CATEGORY}
        onChange={() => undefined}
        disabled
      />
    );
  },
};
