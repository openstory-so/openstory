import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { QueryKey } from '@tanstack/react-query';
import type { ShotView } from '@/shots/shot-view';
import type { Sequence } from '@/platform/server/db/schema';
import { generateMockShots } from '@/mocks/data-generators';
import { MOCK_SYSTEM_STYLES } from '@/look/style-templates';
import { styleKeys } from '@/look/ui/use-styles';
import { sequenceKeys } from '../use-sequences';
import { DEFAULT_SEQUENCES_LIST_PREFS } from '../list-prefs';
import { EvalView } from './eval-view';

const baseSequence: Sequence = {
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
  generationStopAt: null,
  pipelineStage: null,
  generationCheckpoint: null,
  generateStartFrames: true,
  generateVoices: false,
  targetDurationSeconds: null,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
};

const sequences = [
  {
    title: 'The last light',
    status: 'completed' as const,
    posterUrl: '/match-script.jpg',
  },
  {
    title: 'Somewhere, after midnight',
    status: 'processing' as const,
    posterUrl: null,
  },
  {
    title: 'A little further from home',
    status: 'draft' as const,
    posterUrl: null,
  },
  {
    title: 'The world we left behind',
    status: 'failed' as const,
    posterUrl: null,
  },
].map((s, i) => ({
  ...baseSequence,
  ...s,
  id: `sequence-${i}`,
  styleId: MOCK_SYSTEM_STYLES[0]?.id ?? 'style-1',
  createdAt: new Date(2026, 8, 20 - i),
  creatorName: i % 2 ? 'Morgan Chen' : 'Alex Rivers',
  creatorEmail: i % 2 ? 'morgan@example.com' : 'alex@example.com',
}));

function createPreviewClient() {
  // Exercise the real page and comparison components with isolated sample data.
  // Keep fixtures fresh for the lifetime of the preview, including after edits.
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    },
  });
  const seed = (key: QueryKey, data: object) =>
    client.setQueryData(key, data, { updatedAt: Date.now() + 86400000 });
  seed(['session'], {
    user: { id: 'demo-user' },
    session: { activeTeamId: 'demo-team' },
  });
  seed(['system-admin-status'], {
    isAdmin: true,
    internalDomains: ['openstory.so'],
  });
  seed(sequenceKeys.list(), sequences);
  seed(styleKeys.list(), MOCK_SYSTEM_STYLES);
  seed(['archived-sequences'], []);
  seed(['sequence-divergent-by-team', null], []);
  const shotsBySequence = new Map<string, ShotView[]>();
  for (const sequence of sequences) {
    const shots = generateMockShots(2, sequence.id).map<ShotView>(
      (shot, i) => ({
        ...shot,
        sceneId: `${sequence.id}-scene-${i}`,
        imagePromptVersion: {
          id: `${shot.id}-prompt`,
          frameId: shot.frame.id,
          text:
            i === 0
              ? 'Wide shot of a solitary figure on a coastal cliff at dusk. Soft amber light catches the sea mist, cinematic composition, gentle film grain.'
              : 'Close-up of a woman beside a rain-streaked train window at night. Reflections of city lights trace her face, shallow depth of field.',
          components: null,
          source: 'ai-generated',
          status: 'completed',
          inputHash: null,
          pendingInputHash: null,
          workflowRunId: null,
          analysisModel: sequence.analysisModel,
          createdAt: sequence.createdAt,
          createdBy: null,
        },
        video: null,
        primaryVideo: null,
        image: shot.image ? { ...shot.image, url: '/match-script.jpg' } : null,
      })
    );
    shotsBySequence.set(sequence.id, shots);
    seed(['admin-support', 'shots', sequence.id], shots);
    seed(
      ['scenes', 'list', sequence.id],
      shots.map((shot, i) => ({
        id: shot.sceneId,
        sequenceId: sequence.id,
        orderIndex: i,
        script: {
          extract:
            i === 0
              ? 'EXT. COAST — DUSK\nA lone figure watches the last light slip beneath the horizon.'
              : 'INT. TRAIN — NIGHT\nRain traces the window as the city fades behind her.',
          dialogue: [],
        },
      }))
    );
  }
  seed(
    ['shots', 'by-sequences', sequences.map((s) => s.id).sort()],
    shotsBySequence
  );
  seedAdminSearch(client, '');
  return client;
}

function seedAdminSearch(client: QueryClient, search: string) {
  // Seed each search key before rendering so the real support query never falls
  // through to the Storybook server-function stub.
  client.setQueryData(
    ['admin-support', 'sequences', search],
    {
      pages: [
        sequences.filter((s) =>
          `${s.title} ${s.creatorName} ${s.creatorEmail}`
            .toLowerCase()
            .includes(search.toLowerCase())
        ),
      ],
      pageParams: [0],
    },
    { updatedAt: Date.now() + 86400000 }
  );
}

function SequencesPagePreview({ support = false }: { support?: boolean }) {
  const [client] = useState(createPreviewClient);
  const [prefs, setPrefs] = useState({
    ...DEFAULT_SEQUENCES_LIST_PREFS,
    supportMode: support,
  });

  return (
    <QueryClientProvider client={client}>
      <div className="flex h-screen flex-col gap-6 p-6">
        <div>
          <h1 className="text-3xl font-semibold">Sequences</h1>
          <p className="text-muted-foreground">
            Your films, from first draft to final cut.
          </p>
        </div>
        <EvalView
          search={{}}
          prefs={prefs}
          setPrefs={(next) => {
            seedAdminSearch(client, next.search.trim());
            setPrefs(next);
          }}
        />
      </div>
    </QueryClientProvider>
  );
}

const meta: Meta<typeof SequencesPagePreview> = {
  title: 'Sequence/SequencesPage',
  component: SequencesPagePreview,
  parameters: { layout: 'fullscreen' },
};
export default meta;
type Story = StoryObj<typeof meta>;
export const Gallery: Story = {};
export const Support: Story = { args: { support: true } };
