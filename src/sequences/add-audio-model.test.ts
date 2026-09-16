import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TEST_FAL_PRICING } from '@/billing/fal-pricing-fixture';
import { ZERO_MICROS } from '@/billing/money';

// Expose the handler so these tests exercise its real credit preflight with
// an authenticated context, without the server-fn transport or middleware.
vi.doMock('@tanstack/react-start', async () => ({
  ...(await vi.importActual('@tanstack/react-start')),
  createServerFn: () => ({
    middleware() {
      return this;
    },
    validator() {
      return this;
    },
    handler(handler: unknown) {
      return handler;
    },
  }),
}));

const triggerWorkflow = vi.fn(async () => 'wf_music');
vi.doMock('@/platform/server/workflow/client', () => ({ triggerWorkflow }));
vi.doMock('@/billing/server/fal-pricing-live', () => ({
  getEffectiveFalPricing: async () => TEST_FAL_PRICING,
}));

const { addModelToSequenceFn } = await import('./sequences.fn');

function makeContext(canAfford = false) {
  return {
    user: { id: 'u1' },
    sequence: {
      id: 'seq_1',
      teamId: 't1',
      musicPrompt: 'ambient synths',
      musicTags: 'ambient',
    },
    scopedDb: {
      apiKeys: { hasUsableKey: vi.fn(async () => true) },
      billing: {
        hasEnoughCredits: vi.fn(async () => canAfford),
        createReservation: vi.fn(async () =>
          canAfford
            ? {
                ok: true,
                reservationId: 'res_music',
                remaining: ZERO_MICROS,
                replay: false,
              }
            : { ok: false }
        ),
      },
      shots: {
        listBySequence: vi.fn(async () => [{ durationMs: 30_000 }]),
      },
      sequenceVariants: {
        listMusicBySequence: vi.fn(async () => []),
        upsertMusicPrimary: vi.fn(async () => {}),
      },
    },
  };
}

// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- createServerFn mock exposes the handler instead of its transport wrapper
const addAudioModel = addModelToSequenceFn as unknown as (input: {
  data: { sequenceId: string; variantType: 'audio'; model: string };
  context: ReturnType<typeof makeContext>;
}) => Promise<unknown>;

describe('add audio model — music credits', () => {
  beforeEach(() => triggerWorkflow.mockClear());

  it('blocks native music for a fal BYOK team with insufficient credits', async () => {
    const context = makeContext();

    await expect(
      addAudioModel({
        data: {
          sequenceId: 'seq_1',
          variantType: 'audio',
          model: 'elevenlabs_music',
        },
        context,
      })
    ).rejects.toThrow('Insufficient credits to add this audio model');

    expect(context.scopedDb.billing.createReservation).toHaveBeenCalledTimes(1);
    expect(
      context.scopedDb.sequenceVariants.upsertMusicPrimary
    ).not.toHaveBeenCalled();
    expect(triggerWorkflow).not.toHaveBeenCalled();
  });

  it('passes a platform credit reservation to native music generation', async () => {
    const context = makeContext(true);

    await addAudioModel({
      data: {
        sequenceId: 'seq_1',
        variantType: 'audio',
        model: 'elevenlabs_music',
      },
      context,
    });

    expect(context.scopedDb.billing.createReservation).toHaveBeenCalledTimes(1);
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/music',
      expect.objectContaining({
        model: 'elevenlabs_music',
        reservationId: 'res_music',
        ownsReservation: true,
      }),
      expect.anything()
    );
  });

  it('keeps fal BYOK for ACE-Step without platform credits', async () => {
    const context = makeContext();

    await addAudioModel({
      data: { sequenceId: 'seq_1', variantType: 'audio', model: 'ace_step' },
      context,
    });

    expect(context.scopedDb.billing.createReservation).not.toHaveBeenCalled();
    expect(triggerWorkflow).toHaveBeenCalledWith(
      '/music',
      expect.objectContaining({ model: 'ace_step', reservationId: undefined }),
      expect.anything()
    );
  });
});
