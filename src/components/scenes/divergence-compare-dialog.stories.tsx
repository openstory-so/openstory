import type { Meta, StoryObj } from '@storybook/react';
import type { ShotVariant } from '@/lib/db/schema';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import { toShotView, type ShotView } from '@/lib/shots/shot-view';
import { DivergenceCompareDialog } from './divergence-compare-dialog';

const NOW = new Date('2026-04-29T00:00:00Z');

const anchorFrame = frameFixture({
  id: 'frame-1',
  shotId: 'shot-1',
  sequenceId: 'seq-1',
  imageStatus: 'completed',
  createdAt: NOW,
  updatedAt: NOW,
});

const baseShot: ShotView = toShotView(
  {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: 1,
    durationMs: 3000,
    selectedMotionPromptVersionId: null,
    renderSegmentId: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  },
  anchorFrame,
  {
    image: frameVariantFixture({
      frameId: anchorFrame.id,
      sequenceId: 'seq-1',
      url: 'https://images.unsplash.com/photo-1502872364588-894d7d6ddfab',
      inputHash: 'live-hash',
      generatedAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    }),
    preview: null,
    imagePromptVersion: null,
    video: null,
    primaryVideo: null,
  }
);

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
    shot: baseShot,
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
    shot: {
      ...baseShot,
      video: videoVariantFixture({
        renderSegmentId: 'segment-1',
        sequenceId: 'seq-1',
        url: 'https://www.w3schools.com/html/mov_bbb.mp4',
      }),
    },
    variant: makeVariant({
      variantType: 'video',
      url: 'https://www.w3schools.com/html/movie.mp4',
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
