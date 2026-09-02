import type { Meta, StoryObj } from '@storybook/react-vite';

import { AuthGateStub } from '@/components/auth/auth-gate-provider';
import { styleKeys } from '@/hooks/use-styles';
import type { Sequence } from '@/lib/db/schema/sequences';
import { MOCK_SYSTEM_STYLES } from '@/lib/style/style-templates';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScriptView } from './script-view';

// Mock sequence for edit mode stories
const mockSequence: Sequence = {
  id: 'demo-sequence-123',
  teamId: 'demo-team',
  title: 'Demo Video Sequence',
  script: `INT. OFFICE - DAY

Sarah sits at her desk, typing furiously on her laptop. The phone RINGS.

SARAH
(frustrated)
Not now...

She answers anyway, her expression softening.

SARAH (CONT'D)
Oh, hi Mom. Yeah, I'm fine. Just... working on a big project.`,
  status: 'draft',
  createdAt: new Date('2024-01-15T10:30:00Z'),
  updatedAt: new Date('2024-01-15T10:30:00Z'),
  createdBy: null,
  updatedBy: null,
  styleId: 'style-1',
  styleConfig: null,
  aspectRatio: '16:9',
  resolution: '720p',
  analysisModel: 'anthropic/claude-haiku-4.5',
  analysisDurationMs: 0,
  imageModel: 'nano_banana_pro',
  videoModel: 'kling_v2_5_turbo_pro',
  workflow: null,
  musicUrl: null,
  musicPath: null,
  musicStatus: 'pending',
  musicGeneratedAt: null,
  musicError: null,
  musicModel: null,
  musicPrompt: null,
  musicTags: null,
  musicPromptInputHash: null,
  includeMusic: true,
  statusError: null,
  workflowRunId: null,
  posterUrl: null,
  readyEmailSentAt: null,
  autoGenerateMotion: false,
  autoGenerateMusic: false,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
};

// Create a new QueryClient for each story and pre-populate caches that
// ScriptView reads from. Without this, server-fn-backed queries (styles,
// sequence, etc.) hang in Storybook because the server-stub plugin replaces
// their fetch with a no-op.
const createQueryClient = () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
      },
      mutations: {
        retry: false,
      },
    },
  });
  // Cover both the team-scoped and unscoped useStyles() callers.
  client.setQueryData(styleKeys.list('demo-team'), MOCK_SYSTEM_STYLES);
  client.setQueryData(styleKeys.list(undefined), MOCK_SYSTEM_STYLES);
  return client;
};

const meta: Meta<typeof ScriptView> = {
  title: 'Script/ScriptView',
  component: ScriptView,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The complete new sequence creation page with all sections integrated.',
      },
    },
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={createQueryClient()}>
        <AuthGateStub>
          <Story />
        </AuthGateStub>
      </QueryClientProvider>
    ),
  ],
  argTypes: {
    teamId: {
      description: 'The ID of the team to create the sequence for',
      control: 'text',
    },
    sequence: {
      description: 'Full sequence object for edit mode',
      control: 'object',
    },
    loading: {
      description: 'Whether the component is in a loading state',
      control: 'boolean',
    },
    flat: {
      description: 'Whether to render without padding/margins',
      control: 'boolean',
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptView>;

export const Default: Story = {
  args: {
    teamId: 'demo-team',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Default script view showing the complete user flow from script writing to storyboard generation.',
      },
    },
  },
};

export const EditMode: Story = {
  args: {
    teamId: 'demo-team',
    sequence: mockSequence,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Edit mode for updating an existing sequence. Shows the cancel button and updates the sequence instead of creating a new one.',
      },
    },
  },
};

export const Loading: Story = {
  args: {
    teamId: 'demo-team',
    sequence: mockSequence,
    loading: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Loading state shown while the sequence is being processed or saved.',
      },
    },
  },
};
