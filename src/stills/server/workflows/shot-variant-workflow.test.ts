/**
 * #712: a still picked from the 3×3 grid must read stale after a prompt edit,
 * exactly like a generated still. The grid run stamps its sheet with
 * `tileInputHash`; picking a tile copies that stamp onto the tile's version.
 * Staleness then compares it to the live hash it re-derives from the selected
 * version's model (the UPSCALE model), which is what this pins.
 */

import { describe, expect, it } from 'vitest';
import { safeTextToImageModel, type TextToImageModel } from '@/models/models';
import { resolveUpscaleModel } from '@/models/resolve-asset-models';
import { buildRegenerateShotSnapshot as buildRegenerateShotStamp } from '@/shots/server/workflows/regenerate-shots-snapshot';

/** The snapshot half; these tests never read the stamp. */
const buildRegenerateShotSnapshot = async (
  params: Parameters<typeof buildRegenerateShotStamp>[0]
) => (await buildRegenerateShotStamp(params)).snapshot;
import { tileInputHash } from './shot-variant-workflow';

const PROMPT = 'Jack on the docks at dusk, wide';

/** The live hash `computeShotStaleness` builds for a selected tile. */
async function liveTileHash(gridModel: TextToImageModel, prompt: string) {
  const snapshot = await buildRegenerateShotSnapshot({
    shot: { id: 'shot-1' },
    scene: null,
    imagePrompt: prompt,
    characters: [],
    locations: [],
    elements: [],
    // The tile version is written with the upscale model.
    imageModel: safeTextToImageModel(resolveUpscaleModel(gridModel)),
    aspectRatio: '16:9',
  });
  return snapshot.snapshotInputHash;
}

const stamp = (model: TextToImageModel) =>
  tileInputHash({
    model,
    aspectRatio: '16:9',
    tileHashInput: {
      visualPrompt: PROMPT,
      characterSheetHashes: [],
      locationSheetHashes: [],
      elementReferenceHashes: [],
    },
  });

describe('tileInputHash (#712)', () => {
  // hidream_i1 has no edit endpoint, so its tiles upscale on another model.
  it.each<TextToImageModel>(['nano_banana_2', 'hidream_i1'])(
    'reads fresh, then stale after a prompt edit (%s grid)',
    async (gridModel) => {
      const stamped = (await stamp(gridModel))?.hash;
      expect(stamped).toBe(await liveTileHash(gridModel, PROMPT));
      expect(stamped).not.toBe(
        await liveTileHash(gridModel, `${PROMPT}, rain`)
      );
    }
  );

  it('stamps nothing when the trigger had no prompt', () => {
    expect(
      tileInputHash({
        model: 'nano_banana_2',
        aspectRatio: '16:9',
        tileHashInput: null,
      })
    ).toBeNull();
  });
});
