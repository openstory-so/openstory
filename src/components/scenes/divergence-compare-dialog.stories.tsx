import type { Meta, StoryObj } from '@storybook/react';
import type { Shot, ShotVariant } from '@/lib/db/schema';
import { DivergenceCompareDialog } from './divergence-compare-dialog';

const NOW = new Date('2026-04-29T00:00:00Z');

const baseShot: Shot = {
  id: 'shot-1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: null,
  orderIndex: 0,
  description: 'A wide shot.',
  durationMs: 3000,
  thumbnailUrl: 'https://images.unsplash.com/photo-1502872364588-894d7d6ddfab',
  previewThumbnailUrl: null,
  thumbnailPath: null,
  variantImageUrl: null,
  variantImageStatus: 'pending',
  variantWorkflowRunId: null,
  variantImageGeneratedAt: null,
  variantImageError: null,
  videoUrl: null,
  videoPath: null,
  thumbnailStatus: 'completed',
  thumbnailWorkflowRunId: null,
  thumbnailGeneratedAt: null,
  thumbnailError: null,
  imageModel: 'nano_banana_2',
  imagePrompt: null,
  videoStatus: 'pending',
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionPrompt: null,
  motionModel: null,
  audioUrl: null,
  audioPath: null,
  audioStatus: 'pending',
  audioWorkflowRunId: null,
  audioGeneratedAt: null,
  audioError: null,
  audioModel: null,
  thumbnailInputHash: 'live-hash',
  variantImageInputHash: null,
  videoInputHash: null,
  audioInputHash: null,
  visualPromptInputHash: null,
  motionPromptInputHash: null,
  metadata: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function makeVariant(
  overrides: Partial<ShotVariant> & {
    variantType: ShotVariant['variantType'];
  }
): ShotVariant {
  return {
    id: 'variant-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    model: 'nano_banana_2',
    url: 'https://images.unsplash.com/photo-1500530855697-b586d89ba3ee',
    storagePath: null,
    previewUrl: null,
    shotVariantUrl: null,
    shotVariantPath: null,
    shotVariantStatus: null,
    shotVariantWorkflowRunId: null,
    status: 'completed',
    workflowRunId: null,
    generatedAt: new Date(),
    error: null,
    promptHash: null,
    inputHash: 'snapshot-hash',
    divergedAt: new Date('2026-04-29T00:00:00Z'),
    discardedAt: null,
    durationMs: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const meta: Meta<typeof DivergenceCompareDialog> = {
  title: 'Scenes/DivergenceCompareDialog',
  component: DivergenceCompareDialog,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof DivergenceCompareDialog>;

export const ThumbnailVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    frame: baseShot,
    variant: makeVariant({ variantType: 'image' }),
    onPromote: () => {},
    onDiscard: () => {},
    upstreamChanges: [
      'Character "Alex" — sheet regenerated',
      'Location "Warehouse" — recast',
    ],
  },
};

export const VideoVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    frame: {
      ...baseShot,
      videoUrl: 'https://www.w3schools.com/html/mov_bbb.mp4',
    },
    variant: makeVariant({
      variantType: 'video',
      url: 'https://www.w3schools.com/html/movie.mp4',
    }),
    onPromote: () => {},
    onDiscard: () => {},
  },
};

export const AudioVariant: Story = {
  args: {
    open: true,
    onOpenChange: () => {},
    frame: baseShot,
    variant: makeVariant({
      variantType: 'audio',
      url: 'https://www.w3schools.com/html/horse.ogg',
    }),
    onPromote: () => {},
    onDiscard: () => {},
  },
};

export const Promoting: Story = {
  args: {
    ...ThumbnailVariant.args,
    isPromoting: true,
  },
};
