/**
 * Generation through MCP (#2243): sheets, stills and clips on fal and on
 * BytePlus Ark (Seedream / Seedance, with asset ingest), music, and Studio.
 * Ark, fal, ElevenLabs and LLMs replay aimock; Ark assets hit e2e/mocks/byteplus-assets-mock.ts.
 */
import type { APIRequestContext } from 'playwright/test';
import { z } from 'zod';
import { E2E_RECORDING } from '../recording-mode';
import { call } from '../fixtures/mcp';
import { expect, test } from '../fixtures/auth.fixture';
import { createTestSequence } from '../fixtures/sequence.fixture';

const Versions = z.object({
  versions: z.array(
    z.object({
      status: z.string(),
      url: z.string().nullable().optional(),
      error: z.string().nullable().optional(),
    })
  ),
});

/** Poll a version list until `count` versions are done. */
async function settleVersion(
  request: APIRequestContext,
  sequenceId: string,
  kind: string,
  entityId: string,
  count = 1
): Promise<void> {
  for (;;) {
    const { versions } = await call(
      request,
      'list_versions',
      { sequenceId, kind, entityId },
      Versions
    );
    const failed = versions.find((v) => v.status === 'failed');
    expect(failed?.error ?? null, `${kind} failed`).toBeNull();
    const done = versions.filter((v) => v.status === 'completed').length;
    if (done >= count && done === versions.length) return;
    await new Promise((r) => setTimeout(r, E2E_RECORDING ? 5000 : 500));
  }
}

const StudioAsset = z.object({
  document: z.object({ text: z.string() }),
});
const StudioDoc = z.looseObject({
  status: z.string(),
  outputs: z.array(z.object({ url: z.string() })).nullable(),
  error: z.string().nullable().optional(),
});

/** Poll a Studio asset until it is done; returns it. */
async function settleStudio(
  request: APIRequestContext,
  id: string
): Promise<z.infer<typeof StudioDoc>> {
  for (;;) {
    const { document } = await call(
      request,
      'get_generated_asset',
      { id },
      StudioAsset
    );
    const asset = StudioDoc.parse(JSON.parse(document.text));
    expect(asset.status, asset.error ?? '').not.toBe('failed');
    if (asset.status === 'completed') return asset;
    await new Promise((r) => setTimeout(r, E2E_RECORDING ? 5000 : 500));
  }
}

const Created = z.object({
  assets: z.array(z.object({ id: z.string(), workflowRunId: z.string() })),
});

test.describe('Generation', () => {
  test.skip(
    process.env.PLAYWRIGHT_FULL_PIPELINE !== 'true',
    'Workflows run only in the full pipeline (`bun test:e2e:full`).'
  );
  test.setTimeout(E2E_RECORDING ? 20 * 60_000 : 180_000);

  test('sheets, stills and clips on fal and Ark, then music', async ({
    request,
    testUser,
  }) => {
    const { id: sequenceId } = await createTestSequence(
      testUser.organizationId,
      testUser.id,
      'Generation sequence'
    );
    const s = { sequenceId };
    const { sceneId, shotId, scriptVersionId } = await call(
      request,
      'create_scene',
      s,
      z.object({
        sceneId: z.string(),
        shotId: z.string(),
        scriptVersionId: z.string(),
      })
    );
    const { frames } = await call(
      request,
      'list_frames',
      { ...s, shotId },
      z.object({ frames: z.array(z.object({ id: z.string() })) })
    );
    const frameId = frames[0]?.id ?? '';
    await call(request, 'update_shot_prompt', {
      ...s,
      shotId,
      promptType: 'visual',
      text: 'Maya wipes down the counter of the Corner diner at closing time.',
    });
    await call(request, 'update_shot_prompt', {
      ...s,
      shotId,
      promptType: 'motion',
      text: 'Maya looks up as the door bell rings; slow push in.',
    });

    const { characterId } = await call(
      request,
      'create_character',
      {
        ...s,
        name: 'Maya',
        age: '30s',
        physicalDescription: 'Short dark hair, tired eyes',
        standardClothing: 'Diner apron over a grey t-shirt',
        personality: 'Dry, patient',
      },
      z.object({ characterId: z.string() })
    );
    const { locationId } = await call(
      request,
      'create_location',
      {
        ...s,
        name: 'Corner diner',
        type: 'interior',
        description: 'Chrome counter, red stools, rain on the window',
      },
      z.object({ locationId: z.string() })
    );

    // Maya is in the scene, so her sheet is the clip's reference (an Ark asset).
    const { character } = await call(
      request,
      'get_character',
      { ...s, characterId },
      z.object({ character: z.object({ consistencyTag: z.string() }) })
    );
    await call(request, 'update_scene', {
      ...s,
      sceneId,
      expectedScriptVersionId: scriptVersionId,
      continuity: { characterTags: [character.consistencyTag] },
    });

    // Sheets on fal.
    await call(request, 'regenerate_character_sheet', {
      ...s,
      characterId,
      imageModel: 'nano_banana_2_lite',
    });
    await call(request, 'regenerate_location_sheet', {
      ...s,
      locationId,
      imageModel: 'nano_banana_2_lite',
    });
    await settleVersion(request, sequenceId, 'character_sheet', characterId);
    await settleVersion(request, sequenceId, 'location_sheet', locationId);

    // A still on Ark (Seedream), then a clip on Ark (Seedance, assets ingested).
    await call(request, 'generate_shot_image', {
      ...s,
      shotId,
      model: 'seedream_v5',
    });
    await settleVersion(request, sequenceId, 'image', frameId);
    await call(request, 'generate_shot_video', {
      ...s,
      shotId,
      model: 'seedance_v2_5',
      duration: 4,
      draft: true,
    });
    const { segments } = await call(
      request,
      'list_render_segments',
      { ...s, sceneId },
      z.object({ segments: z.array(z.object({ id: z.string() })) })
    );
    const segmentId = segments[0]?.id ?? '';
    await settleVersion(request, sequenceId, 'video', segmentId);

    // A second still on fal.
    await call(request, 'generate_shot_image', {
      ...s,
      shotId,
      model: 'nano_banana_2_lite',
    });
    await settleVersion(request, sequenceId, 'image', frameId, 2);

    const music = await call(
      request,
      'generate_music',
      {
        ...s,
        model: 'elevenlabs_music',
        prompt: 'Late-night lo-fi piano',
        tags: 'lo-fi, piano, rain',
        duration: 10,
      },
      z.object({ started: z.boolean(), variantId: z.string().nullable() })
    );
    expect(music.started).toBe(true);
  });

  test('Studio: an Ark image, a Seedance draft that references it, an edit', async ({
    request,
  }) => {
    const { prompt } = await call(
      request,
      'draft_studio_prompt',
      { activity: 'image' },
      z.object({ prompt: z.string() })
    );
    expect(prompt.length).toBeGreaterThan(0);

    const image = await call(
      request,
      'create_studio_assets',
      {
        activity: 'image',
        imageModel: 'seedream_v5',
        prompt: 'A diner waitress in a grey t-shirt, three-quarter view.',
        aspectRatio: '16:9',
        count: 1,
      },
      Created
    );
    const still = await settleStudio(request, image.assets[0]?.id ?? '');
    const stillUrl = still.outputs?.[0]?.url;
    expect(stillUrl).toBeTruthy();

    const clip = await call(
      request,
      'create_studio_assets',
      {
        activity: 'video',
        videoModel: 'seedance_v2_5',
        mode: 'reference',
        prompt: '@Image1 turns to the camera and smiles.',
        referenceImages: [stillUrl],
        aspectRatio: '16:9',
        duration: 4,
        draft: true,
      },
      Created
    );
    await settleStudio(request, clip.assets[0]?.id ?? '');

    const edited = await call(
      request,
      'edit_studio_asset',
      { id: clip.assets[0]?.id, prompt: 'Make her apron red.', draft: true },
      Created
    );
    await settleStudio(request, edited.assets[0]?.id ?? '');
  });
});
