import {
  createInitialState,
  type GenerationPhase,
  type GenerationStreamState,
} from '@/lib/realtime/generation-stream.reducer';
import type { Meta, StoryObj } from '@storybook/react';
import { CanvasViewToggle } from '@/components/scenes/canvas-view-toggle';
import { GenerationProgressBanner } from './generation-progress-banner';

function makeState(
  overrides: Partial<GenerationStreamState> & { phases: GenerationPhase[] }
): GenerationStreamState {
  return {
    currentPhase: 0,
    scenes: [],
    shots: new Map(),
    isComplete: false,
    isFailed: false,
    talentMatches: [],
    locationMatches: [],
    unusedTalent: null,
    shotRetries: new Map(),
    ...overrides,
  };
}

function withPhaseProgress(
  base: GenerationStreamState,
  activePhase: number
): GenerationStreamState {
  return {
    ...base,
    currentPhase: activePhase,
    phases: base.phases.map((p) => ({
      ...p,
      status:
        p.phase < activePhase
          ? 'completed'
          : p.phase === activePhase
            ? 'active'
            : 'pending',
    })),
  };
}

const fourPhases = createInitialState({
  autoGenerateMotion: false,
  autoGenerateMusic: false,
});

const fivePhasesMotion = createInitialState({
  autoGenerateMotion: true,
  autoGenerateMusic: false,
});

const fivePhasesMusic = createInitialState({
  autoGenerateMotion: false,
  autoGenerateMusic: true,
});

const fivePhasesBoth = createInitialState({
  autoGenerateMotion: true,
  autoGenerateMusic: true,
});

const meta: Meta<typeof GenerationProgressBanner> = {
  title: 'Generation/GenerationProgressBanner',
  component: GenerationProgressBanner,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    // Shown where it actually lives: the Canvas/Script toolbar's leading slot.
    (Story) => (
      <div className="mx-auto max-w-6xl">
        <CanvasViewToggle
          view="canvas"
          onViewChange={() => {}}
          leading={<Story />}
        />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof GenerationProgressBanner>;

// --- 4 phases (auto-generate off) ---

export const FourPhases_Phase1: Story = {
  name: '4 phases - Script analysis',
  args: {
    generationState: withPhaseProgress(fourPhases, 1),
    isProcessing: true,
    startedAt: new Date(),
  },
};

export const FourPhases_Phase3: Story = {
  name: '4 phases - Generating prompts',
  args: {
    generationState: withPhaseProgress(fourPhases, 3),
    isProcessing: true,
    startedAt: new Date(Date.now() - 60_000),
  },
};

export const FourPhases_Phase4: Story = {
  name: '4 phases - Generating images (last phase)',
  args: {
    generationState: withPhaseProgress(fourPhases, 4),
    isProcessing: true,
    startedAt: new Date(Date.now() - 90_000),
  },
};

// --- 5 phases (motion only) ---

export const FivePhasesMotion_Phase4: Story = {
  name: '5 phases (motion) - Generating images',
  args: {
    generationState: withPhaseProgress(fivePhasesMotion, 4),
    isProcessing: true,
    startedAt: new Date(Date.now() - 90_000),
  },
};

export const FivePhasesMotion_Phase5: Story = {
  name: '5 phases (motion) - Motion video',
  args: {
    generationState: withPhaseProgress(fivePhasesMotion, 5),
    isProcessing: true,
    startedAt: new Date(Date.now() - 150_000),
  },
};

// --- 5 phases (music only) ---

export const FivePhasesMusic_Phase5: Story = {
  name: '5 phases (music) - Music generation',
  args: {
    generationState: withPhaseProgress(fivePhasesMusic, 5),
    isProcessing: true,
    startedAt: new Date(Date.now() - 150_000),
  },
};

// --- 5 phases (both) ---

export const FivePhasesBoth_Phase4: Story = {
  name: '5 phases (both) - Generating images',
  args: {
    generationState: withPhaseProgress(fivePhasesBoth, 4),
    isProcessing: true,
    startedAt: new Date(Date.now() - 90_000),
  },
};

export const FivePhasesBoth_Phase5: Story = {
  name: '5 phases (both) - Video & Music',
  args: {
    generationState: withPhaseProgress(fivePhasesBoth, 5),
    isProcessing: true,
    startedAt: new Date(Date.now() - 150_000),
  },
};

// --- Edge cases ---

export const AllComplete: Story = {
  name: 'All phases complete (4 phases)',
  args: {
    generationState: makeState({
      ...fourPhases,
      currentPhase: 5,
      isComplete: true,
      phases: fourPhases.phases.map((p) => ({ ...p, status: 'completed' })),
    }),
    isProcessing: true,
    startedAt: new Date(Date.now() - 180_000),
  },
};

export const WithScenes: Story = {
  name: 'With streamed scenes',
  args: {
    generationState: {
      ...withPhaseProgress(fourPhases, 4),
      scenes: [
        {
          sceneId: 's1',
          sceneNumber: 1,
          title: 'Opening shot',
          scriptExtract: 'The camera pans across...',
          durationSeconds: 5,
        },
        {
          sceneId: 's2',
          sceneNumber: 2,
          title: 'Character introduction',
          scriptExtract: 'We see the protagonist...',
          durationSeconds: 8,
        },
        {
          sceneId: 's3',
          sceneNumber: 3,
          title: 'The conflict',
          scriptExtract: 'Tension rises as...',
          durationSeconds: 6,
        },
      ],
    },
    isProcessing: true,
    startedAt: new Date(Date.now() - 95_000),
    script:
      'A short film about a detective investigating a mysterious disappearance in a small coastal town. The opening shows the foggy harbor at dawn.',
  },
};
