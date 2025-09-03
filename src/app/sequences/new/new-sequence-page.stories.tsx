import type { Meta, StoryObj } from "@storybook/nextjs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import NewSequencePage from "./page";

// Create a new QueryClient for each story to avoid state leakage
const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

const meta: Meta<typeof NewSequencePage> = {
  title: "Pages/NewSequencePage",
  component: NewSequencePage,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The complete new sequence creation page with all sections integrated.",
      },
    },
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={createQueryClient()}>
        <Story />
      </QueryClientProvider>
    ),
  ],
  argTypes: {
    searchParams: {
      description: "URL search parameters including optional teamId",
      control: "object",
    },
  },
};

export default meta;
type Story = StoryObj<typeof NewSequencePage>;

export const Default: Story = {
  args: {
    searchParams: {},
  },
  parameters: {
    docs: {
      description: {
        story:
          "Default new sequence page showing the complete user flow from script writing to storyboard generation.",
      },
    },
  },
};

export const WithTeamId: Story = {
  args: {
    searchParams: {
      teamId: "demo-team",
    },
  },
  parameters: {
    docs: {
      description: {
        story:
          "New sequence page configured for a specific team with team-specific styles.",
      },
    },
  },
};
