import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { NewCharacterForm } from './new-character-form';

const meta: Meta<typeof NewCharacterForm> = {
  title: 'Cast/NewCharacterForm',
  component: NewCharacterForm,
  render: (args) => (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New character</DialogTitle>
          <DialogDescription>
            The rest of the bible, looks and voice are on its page.
          </DialogDescription>
        </DialogHeader>
        <NewCharacterForm {...args} />
      </DialogContent>
    </Dialog>
  ),
  argTypes: {
    onSubmit: { action: 'submitted' },
    onEdit: { action: 'edited' },
  },
};

export default meta;
type Story = StoryObj<typeof NewCharacterForm>;

export const Empty: Story = { args: { isPending: false } };

export const Creating: Story = { args: { isPending: true } };
