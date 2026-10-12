/**
 * MCP tools that spend credits on one shot or the sequence's models, and the
 * media upload path (#1979): regenerate a still, render variants and pick
 * one, generate or cancel a shot's video, render drafts at quality, add or
 * set a model, upload a file and attach it as a still, clip, music track,
 * sheet or element. Each calls the function the editor's server fn calls;
 * MCP adds only the parent-chain check.
 */
import { z } from 'zod';
import {
  attachElementUpload,
  replaceElementUpload,
} from '@/cast/server/sequence-elements/attach-element-upload';
import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { getVariantGridConfig } from '@/models/aspect-ratios';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidTextToImageModel,
  supportsDraftMode,
  supportsReferenceImages,
  type ImageToVideoModel,
} from '@/models/models';
import {
  STUDIO_VIDEO_MODES,
  studioAudioLimit,
  studioReferenceLimit,
  studioSupportsAutoDuration,
  studioSupportsEndFrame,
  studioSupportsMode,
  studioVideoDurations,
  studioVideoRefLimit,
  studioVideoSupportsAudio,
} from '@/studio/text-to-video';
import {
  cancelVideoRender,
  generateShotMotion,
  renderSequenceDraftsAtQuality,
  renderShotAtQuality,
} from '@/motion/server/shot-motion-generation';
import { ValidationError } from '@/platform/errors';
import { VARIANT_TYPES } from '@/platform/server/db/schema/shot-variants';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  fromShareableUrl,
  r2KeyFromUrl,
  toShareableUrl,
} from '@/platform/server/storage/buckets';
import { productionAccess } from '@/sequences/server/production-access';
import {
  addModelToSequence,
  setSequenceModel,
} from '@/sequences/server/sequence-models';
import {
  MAX_INLINE_UPLOAD_BYTES,
  replaceFrameContent,
  setCharacterSheetFromUpload,
  setLocationSheetFromUpload,
  setSequenceMusicFromUpload,
  setShotVideoFromUpload,
  storeUpload,
  UPLOAD_USES,
} from '@/shots/server/media-upload';
import {
  generateMotionSchema,
  generateVariantSchema,
  regenerateShotSchema,
} from '@/shots/server/shot.schemas';
import {
  generateShotImage,
  generateShotImageVariants,
  selectShotImageVariant,
} from '@/stills/server/shot-image-generation';
import { openstoryTool, productionRead } from '../tool-context';
import { shotEdit } from './shot-content-edits';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Starts paid provider work. */
const paid = { ...writeAnnotations, openWorldHint: true };

const sequenceId = ulidSchema;
const shotInput = z.strictObject({
  sequenceId,
  shotId: ulidSchema.describe('Shot ID (list_shots / get_shot).'),
});
const uploadRef = z
  .string()
  .min(1)
  .max(2048)
  .describe('The upload value upload_media returned.');
const runResult = z.object({ workflowRunId: z.string(), shotId: z.string() });

/**
 * The stored `/r2/` form of an upload reference (`upload`, or the `url` read
 * back from upload_media); attach validates the rest.
 */
function storedUpload(upload: string): string {
  const key = r2KeyFromUrl(fromShareableUrl(upload));
  if (!key) {
    throw new ValidationError(
      'upload must be the value upload_media returned.'
    );
  }
  return `/r2/${key}`;
}

// ── Reads ───────────────────────────────────────────────────────────────────

const listModels = productionRead(
  'list_models',
  'List the image, video and music models generation tools accept, by the id they take. draftMode marks video models that can render an Ark draft first (generate_shot_video draft, create_studio_assets draft). studio is what create_studio_assets takes from the model, null when the Studio does not offer it. The sequence defaults are in get_sequence_settings.',
  z.strictObject({}),
  z.object({
    image: z.array(
      z.object({
        model: z.string(),
        name: z.string(),
        vendor: z.string(),
        studio: z.object({ referenceImages: z.boolean() }).nullable(),
      })
    ),
    video: z.array(
      z.object({
        model: z.string(),
        name: z.string(),
        vendor: z.string(),
        supportsAudio: z.boolean(),
        draftMode: z.boolean(),
        studio: z
          .object({
            modes: z.array(z.enum(STUDIO_VIDEO_MODES)),
            durations: z.array(z.union([z.number(), z.literal('auto')])),
            maxReferenceImages: z.number(),
            maxReferenceVideos: z.number(),
            maxReferenceAudio: z.number(),
            endFrame: z.boolean(),
            generateAudio: z.boolean(),
          })
          .nullable(),
      })
    ),
    music: z.array(
      z.object({ model: z.string(), name: z.string(), vendor: z.string() })
    ),
  }),
  () =>
    Promise.resolve({
      image: Object.entries(IMAGE_MODELS).map(([model, config]) => ({
        model,
        name: config.name,
        vendor: config.vendor,
        studio:
          'hidden' in config
            ? null
            : {
                referenceImages:
                  isValidTextToImageModel(model) &&
                  supportsReferenceImages(model),
              },
      })),
      video: Object.entries(IMAGE_TO_VIDEO_MODELS).map(([key, config]) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Object.entries loses the key type of the catalog
        const model = key as ImageToVideoModel;
        return {
          model,
          name: config.name,
          vendor: config.vendor,
          supportsAudio: 'supportsAudio' in config && config.supportsAudio,
          draftMode: supportsDraftMode(model),
          studio:
            'hidden' in config
              ? null
              : {
                  modes: STUDIO_VIDEO_MODES.filter((mode) =>
                    studioSupportsMode(model, mode)
                  ),
                  durations: [
                    ...(studioSupportsAutoDuration(model)
                      ? (['auto'] as const)
                      : []),
                    ...studioVideoDurations(model),
                  ],
                  maxReferenceImages: studioReferenceLimit(model),
                  maxReferenceVideos: studioVideoRefLimit(model),
                  maxReferenceAudio: studioAudioLimit(model),
                  endFrame: studioSupportsEndFrame(model),
                  generateAudio: studioVideoSupportsAudio(model),
                },
        };
      }),
      music: Object.entries(AUDIO_MODELS).map(([model, config]) => ({
        model,
        name: config.name,
        vendor: config.vendor,
      })),
    })
);

const getShotVariantGrid = productionRead(
  'get_shot_variant_grid',
  'Read the shot’s latest variant grid (generate_shot_image_variants): its image, status, and how tiles are numbered for select_shot_image_variant (index 0 is top-left, row by row). grid is null when the shot has none.',
  shotInput,
  z.object({
    shotId: z.string(),
    grid: z
      .object({
        versionId: z.string(),
        status: z.string(),
        url: z.string().nullable(),
        model: z.string(),
        cols: z.number(),
        rows: z.number(),
        tiles: z.number(),
      })
      .nullable(),
  }),
  async (input, { scopedDb, userId, origin }) => {
    const { shot, frame, sequence } = await shotEdit(scopedDb, userId, input);
    const sheet = await scopedDb.frameVariants.getLatestGridSheet(frame.id);
    const config = getVariantGridConfig(sequence.aspectRatio);
    return {
      shotId: shot.id,
      grid: sheet
        ? {
            versionId: sheet.id,
            status: sheet.status,
            url: sheet.url ? toShareableUrl(sheet.url, origin) : null,
            model: sheet.model,
            cols: config.cols,
            rows: config.rows,
            tiles: config.count,
          }
        : null,
    };
  }
);

// ── Stills ──────────────────────────────────────────────────────────────────

const generateShotImageTool = openstoryTool({
  name: 'generate_shot_image',
  description:
    'Regenerate one shot’s still (uses credits). model (list_models image) overrides the shot’s model; prompt replaces its visual prompt for this render and is saved as the selected one. A render already running for the same inputs is returned (alreadyInFlight) and nothing is charged. The still lands when the run finishes (get_shot).',
  scope: 'generate',
  annotations: paid,
  inputSchema: shotInput.extend({
    model: regenerateShotSchema.shape.model,
    prompt: z.string().max(20000).optional(),
  }),
  outputSchema: runResult.extend({
    workflowRunId: z.string().nullable(),
    alreadyInFlight: z.boolean(),
  }),
  run: async ({ model, prompt, ...input }, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await generateShotImage(context, { model, prompt });
    return {
      data: result,
      summary: result.alreadyInFlight
        ? 'That still is already rendering.'
        : 'Started the still.',
    };
  },
});

const generateShotImageVariantsTool = openstoryTool({
  name: 'generate_shot_image_variants',
  description:
    'Render a grid of variations of the shot’s current still (uses credits; the shot needs a still). When it lands, read it with get_shot_variant_grid and pick a tile with select_shot_image_variant.',
  scope: 'generate',
  annotations: paid,
  inputSchema: shotInput.extend({
    model: generateVariantSchema.shape.model,
    seed: generateVariantSchema.shape.seed,
  }),
  outputSchema: runResult,
  run: async ({ model, seed, ...input }, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await generateShotImageVariants(context, { model, seed });
    return { data: result, summary: 'Started the variant grid.' };
  },
});

const selectShotImageVariantTool = openstoryTool({
  name: 'select_shot_image_variant',
  description:
    'Use one tile of the shot’s latest variant grid as its still (uses credits: the tile is upscaled, and becomes the selected still when that lands). variantIndex counts from 0, top-left, row by row (get_shot_variant_grid).',
  scope: 'generate',
  annotations: paid,
  inputSchema: shotInput.extend({
    variantIndex: z.int().min(0).max(8),
  }),
  outputSchema: z.object({
    shotId: z.string(),
    variantIndex: z.number(),
    tileUrl: z.string(),
    workflowRunId: z.string(),
  }),
  run: async ({ variantIndex, ...input }, { scopedDb, userId, origin }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await selectShotImageVariant(context, { variantIndex });
    return {
      data: {
        shotId: result.shotId,
        variantIndex: result.variantIndex,
        tileUrl: toShareableUrl(result.thumbnailUrl, origin),
        workflowRunId: result.upscaleWorkflowRunId,
      },
      summary: `Upscaling tile ${variantIndex}.`,
    };
  },
});

// ── Motion ──────────────────────────────────────────────────────────────────

const generateShotVideoTool = openstoryTool({
  name: 'generate_shot_video',
  description:
    'Generate (or regenerate) the clip for one shot (uses credits). On a model that packs several shots into one clip, its scene-mates in the same clip render too (packedShotIds). model (list_models video) overrides the shot’s model; prompt replaces its motion prompt and is saved; duration (seconds) applies to a single-shot clip; generateAudio asks audio-capable models for sound; draft renders an Ark draft first (draftMode models on the BytePlus route). Refused before any charge when the shot has no still to animate, a reference cannot be used, or the model cannot render it.',
  scope: 'generate',
  annotations: paid,
  inputSchema: shotInput.extend({
    model: generateMotionSchema.shape.model,
    prompt: z.string().max(20000).optional(),
    duration: generateMotionSchema.shape.duration,
    generateAudio: generateMotionSchema.shape.generateAudio,
    draft: generateMotionSchema.shape.draft,
  }),
  outputSchema: runResult.extend({ packedShotIds: z.array(z.string()) }),
  run: async (
    { model, prompt, duration, generateAudio, draft, ...input },
    { scopedDb, userId }
  ) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await generateShotMotion(context, {
      model,
      prompt,
      duration,
      generateAudio,
      draft,
    });
    return {
      data: result,
      summary: `Started the clip (${result.packedShotIds.length} shot${result.packedShotIds.length === 1 ? '' : 's'}).`,
    };
  },
});

const cancelVideoRenderTool = openstoryTool({
  name: 'cancel_video_render',
  description:
    'Cancel an in-flight video render of this shot (versionId: a generating version in list_versions kind video for the shot’s render segment). The version is marked cancelled and a result that lands later is discarded; the provider job is not stopped and its spend is not refunded. cancelled is false when it had already finished.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: shotInput.extend({ versionId: ulidSchema }),
  outputSchema: z.object({ cancelled: z.boolean() }),
  run: async ({ versionId, ...input }, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await cancelVideoRender(context, {
      sequenceId: context.sequence.id,
      versionId,
    });
    return {
      data: result,
      summary: result.cancelled
        ? 'Cancelled the render.'
        : 'That render had already finished.',
    };
  },
});

const renderShotAtQualityTool = openstoryTool({
  name: 'render_shot_at_quality',
  description:
    'Render the shot’s selected Ark draft at 1080p (uses credits). The final lands as a new version of the same clip and becomes selected when it finishes. Refused when the selected clip is not a finished draft, is over seven days old, or is already rendering.',
  scope: 'generate',
  annotations: paid,
  inputSchema: shotInput,
  outputSchema: z.object({ workflowRunId: z.string(), versionId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    return {
      data: await renderShotAtQuality(context),
      summary: 'Started the 1080p render.',
    };
  },
});

const renderSequenceDraftsAtQualityTool = openstoryTool({
  name: 'render_sequence_drafts_at_quality',
  description:
    'Render every selected Ark draft in the sequence at 1080p (uses credits), one run per clip. Clips already rendering are skipped (skipped); clips that are not usable drafts are left out.',
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({ sequenceId }),
  outputSchema: z.object({ started: z.number(), skipped: z.number() }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const result = await renderSequenceDraftsAtQuality({
      scopedDb,
      user: { id: userId },
      sequence,
    });
    return {
      data: result,
      summary: `Started ${result.started} render${result.started === 1 ? '' : 's'}; skipped ${result.skipped}.`,
    };
  },
});

// ── Sequence models ─────────────────────────────────────────────────────────

const addModelToSequenceTool = openstoryTool({
  name: 'add_model_to_sequence',
  description:
    'Generate with one more model across the sequence (uses credits), from the existing prompts: a still per shot (image), a clip per shot with a still (video), or one music track (audio, after music exists). The results land as alternate versions; select_sequence_model switches the sequence to them. Refused when the model is already on the sequence.',
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({
    sequenceId,
    variantType: z.enum(VARIANT_TYPES),
    model: z.string().min(1).describe('A model id from list_models.'),
  }),
  outputSchema: z.object({
    workflowRunId: z.string(),
    variantType: z.string(),
    model: z.string(),
    count: z.number(),
    failed: z.number(),
  }),
  run: async ({ sequenceId: id, ...data }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const result = await addModelToSequence(
      { scopedDb, user: { id: userId }, sequence },
      data
    );
    return {
      data: result,
      summary: `Started ${result.model} on ${result.count} unit${result.count === 1 ? '' : 's'}.`,
    };
  },
});

const selectSequenceModelTool = openstoryTool({
  name: 'select_sequence_model',
  description:
    'Switch every shot that has a finished still (image) or clip (video) from this model to it. Shots the model never rendered keep theirs. Selecting stills makes their clips stale. Starts no generation.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({
    sequenceId,
    variantType: z.enum(['image', 'video']),
    model: z.string().min(1).describe('A model id from list_models.'),
  }),
  outputSchema: z.object({
    count: z.number(),
    variantType: z.string(),
    model: z.string(),
  }),
  run: async ({ sequenceId: id, ...data }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const result = await setSequenceModel(
      { scopedDb, user: { id: userId }, sequence },
      data
    );
    return {
      data: result,
      summary: `Selected ${result.model} on ${result.count} shot${result.count === 1 ? '' : 's'}.`,
    };
  },
});

// ── Uploads ─────────────────────────────────────────────────────────────────

const uploadMediaTool = openstoryTool({
  name: 'upload_media',
  description: `Upload a file (for example one the user attached in chat) to use in a sequence or the Studio. Send url (a public http(s) link) or data (base64, at most ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB decoded; larger files need a url) with mimeType. use says what it is for: shot_image, character_sheet, location_sheet (JPEG, PNG, WebP, GIF), shot_video (MP4, WebM, MOV), music (MP3, WAV, OGG, M4A) or element (an image, MP3/WAV or MP4/MOV), or studio (the same types as element; no sequenceId) for a Studio reference, start or end frame. Images are checked for a real person; one who is needs portraitAttestation, the uploader’s confirmation they hold the rights to that likeness. Returns upload, which the set_*_from_upload, element and Studio tools take. Uploading changes nothing in the sequence or the Studio.`,
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z
    .strictObject({
      sequenceId: sequenceId
        .optional()
        .describe('The sequence the file is for; omit for use studio.'),
      use: z.enum(UPLOAD_USES),
      url: z.url().max(2048).optional(),
      data: z
        .string()
        .min(1)
        .max(Math.ceil((MAX_INLINE_UPLOAD_BYTES * 4) / 3) + 4)
        .optional()
        .describe('Base64 file bytes (no data: prefix).'),
      mimeType: z.string().min(1).max(100).optional(),
      filename: z.string().min(1).max(255).optional(),
      portraitAttestation: z
        .strictObject({
          statementVersion: z.literal(PORTRAIT_RIGHTS_V1.version),
          authorizationBasis: z
            .string()
            .trim()
            .min(1)
            .max(500)
            .describe(
              'Basis for the authorization: a release reference, "self", a contract id.'
            ),
        })
        .optional(),
    })
    .refine((i) => (i.url === undefined) !== (i.data === undefined), {
      message: 'Send url or data, not both.',
    })
    .refine((i) => i.data === undefined || i.mimeType !== undefined, {
      message: 'data needs mimeType.',
    })
    .refine((i) => (i.use === 'studio') === (i.sequenceId === undefined), {
      message: 'Send sequenceId, except for use studio.',
    }),
  outputSchema: z.object({
    upload: z.string(),
    url: z.string(),
    use: z.string(),
    mediaType: z.string(),
    bytes: z.number().nullable(),
    rights: z.enum(['cleared', 'signed', 'not_checked']),
  }),
  run: async (input, { scopedDb, userId, origin, request }) => {
    const sequence = input.sequenceId
      ? await productionAccess(scopedDb).sequence(input.sequenceId)
      : null;
    const stored = await storeUpload({
      scopedDb,
      userId,
      sequenceId: sequence?.id ?? null,
      use: input.use,
      source:
        input.data !== undefined && input.mimeType !== undefined
          ? { data: input.data, mimeType: input.mimeType }
          : { url: input.url ?? '' },
      filename: input.filename,
      portraitAttestation: input.portraitAttestation,
      request,
    });
    return {
      data: {
        upload: stored.url,
        url: toShareableUrl(stored.url, origin),
        use: input.use,
        mediaType: stored.mediaType,
        bytes: stored.bytes,
        rights: stored.rights,
      },
      summary: `Uploaded the ${input.use.replace('_', ' ')}.`,
    };
  },
});

const setShotImageFromUploadTool = openstoryTool({
  name: 'set_shot_image_from_upload',
  description:
    'Make an uploaded image (upload_media use shot_image) the shot’s selected still. prompt, when sent and different, also becomes its selected visual prompt, saved together with the image. The shot’s clip becomes stale.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({
    upload: uploadRef,
    prompt: z.string().max(20000).optional(),
  }),
  outputSchema: z.object({
    shotId: z.string(),
    versionId: z.string(),
    promptVersionId: z.string().nullable(),
    promptChanged: z.boolean(),
  }),
  run: async ({ upload, prompt, ...input }, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await replaceFrameContent(context, {
      publicUrl: storedUpload(upload),
      promptText: prompt,
    });
    return { data: result, summary: 'Set the shot’s still.' };
  },
});

const setShotVideoFromUploadTool = openstoryTool({
  name: 'set_shot_video_from_upload',
  description:
    'Make an uploaded clip (upload_media use shot_video) the shot’s selected video. The shot’s duration becomes the clip’s length. Refused when the shot shares a clip with others in its scene.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: shotInput.extend({ upload: uploadRef }),
  outputSchema: z.object({
    shotId: z.string(),
    versionId: z.string(),
    durationSeconds: z.number().nullable(),
  }),
  run: async ({ upload, ...input }, { scopedDb, userId }) => {
    const context = await shotEdit(scopedDb, userId, input);
    const result = await setShotVideoFromUpload(context, {
      publicUrl: storedUpload(upload),
    });
    return {
      data: {
        shotId: result.shotId,
        versionId: result.versionId,
        durationSeconds: result.durationSeconds,
      },
      summary: 'Set the shot’s video.',
    };
  },
});

const setMusicFromUploadTool = openstoryTool({
  name: 'set_music_from_upload',
  description:
    'Make an uploaded track (upload_media use music) the sequence’s music and turn music on. Earlier tracks stay selectable (select_music_track).',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({ sequenceId, upload: uploadRef }),
  outputSchema: z.object({ variantId: z.string() }),
  run: async ({ upload, sequenceId: id }, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(id);
    const result = await setSequenceMusicFromUpload(
      { scopedDb, user: { id: userId }, teamId: scopedDb.teamId, sequence },
      { publicUrl: storedUpload(upload) }
    );
    return {
      data: { variantId: result.variantId },
      summary: 'Set the music.',
    };
  },
});

const setCharacterSheetFromUploadTool = openstoryTool({
  name: 'set_character_sheet_from_upload',
  description:
    'Make an uploaded image (upload_media use character_sheet) the selected reference sheet of one look of a character (lookId; the default look if omitted). Allowed for any look at any time. A look other than the default is stamped with the default look’s sheet as it is now (none if it has none), so it reads stale once a new default sheet lands. Stills of shots that wear the look become stale. Starts no generation.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({
    sequenceId,
    characterId: ulidSchema.describe(
      'Database character ID (list_characters).'
    ),
    lookId: ulidSchema
      .optional()
      .describe('Look ID (get_character looks[].id); default look if omitted.'),
    upload: uploadRef,
  }),
  outputSchema: z.object({ characterId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const character = await productionAccess(scopedDb).character(
      input.sequenceId,
      input.characterId
    );
    const sequence = await productionAccess(scopedDb).sequence(
      character.sequenceId
    );
    await setCharacterSheetFromUpload(
      { scopedDb, user: { id: userId }, teamId: scopedDb.teamId, sequence },
      {
        characterId: character.id,
        lookId: input.lookId ?? character.id,
        publicUrl: storedUpload(input.upload),
      }
    );
    return {
      data: { characterId: character.id },
      summary: `Set the sheet for ${character.name}.`,
    };
  },
});

const setLocationSheetFromUploadTool = openstoryTool({
  name: 'set_location_sheet_from_upload',
  description:
    'Make an uploaded image (upload_media use location_sheet) the location’s selected reference. Stills of shots at the location become stale. Starts no generation.',
  scope: 'sequences:write',
  annotations: writeAnnotations,
  inputSchema: z.strictObject({
    sequenceId,
    locationId: ulidSchema.describe('Database location ID (list_locations).'),
    upload: uploadRef,
  }),
  outputSchema: z.object({ locationId: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const location = await productionAccess(scopedDb).location(
      input.sequenceId,
      input.locationId
    );
    const sequence = await productionAccess(scopedDb).sequence(
      location.sequenceId
    );
    await setLocationSheetFromUpload(
      { scopedDb, user: { id: userId }, teamId: scopedDb.teamId, sequence },
      { locationDbId: location.id, publicUrl: storedUpload(input.upload) }
    );
    return {
      data: { locationId: location.id },
      summary: `Set the reference for ${location.name}.`,
    };
  },
});

/** The element key and the filename its kind and token come from. */
function elementUpload(upload: string, name: string) {
  const path = storedUpload(upload).slice('/r2/'.length);
  const ext = path.split('.').pop() ?? '';
  return { path, filename: `${name}.${ext}` };
}
const elementName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^/\\.]+$/, 'No dots or slashes.')
  .describe('What the element is, e.g. "Logo"; its @token is derived from it.');

const addElementTool = openstoryTool({
  name: 'add_element',
  description:
    'Add an uploaded file (upload_media use element) to the sequence as an element: an image, clip or audio file the script and prompts mention by @token. An image is described by a vision model (uses credits); set_element_description describes a clip or audio file.',
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({
    sequenceId,
    upload: uploadRef,
    name: elementName,
  }),
  outputSchema: z.object({
    elementId: z.string(),
    token: z.string(),
    kind: z.string(),
  }),
  run: async (input, { scopedDb, userId }) => {
    const sequence = await productionAccess(scopedDb).sequence(
      input.sequenceId
    );
    const element = await attachElementUpload({
      scopedDb,
      teamId: scopedDb.teamId,
      userId,
      sequenceId: sequence.id,
      ...elementUpload(input.upload, input.name),
    });
    return {
      data: {
        elementId: element.id,
        token: element.token,
        kind: element.kind,
      },
      summary: `Added element ${element.token}.`,
    };
  },
});

const replaceElementTool = openstoryTool({
  name: 'replace_element',
  description:
    'Replace an element’s file with an upload (upload_media use element); its @token stays. The description is cleared and an image is described again (uses credits). Shots that use it become stale.',
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({
    sequenceId,
    elementId: ulidSchema.describe('Database element ID (list_elements).'),
    upload: uploadRef,
    name: elementName,
  }),
  outputSchema: z.object({ elementId: z.string(), kind: z.string() }),
  run: async (input, { scopedDb, userId }) => {
    const element = await productionAccess(scopedDb).element(
      input.sequenceId,
      input.elementId
    );
    const updated = await replaceElementUpload({
      scopedDb,
      teamId: scopedDb.teamId,
      userId,
      sequenceId: element.sequenceId,
      elementId: element.id,
      ...elementUpload(input.upload, input.name),
    });
    return {
      data: { elementId: updated.id, kind: updated.kind },
      summary: `Replaced element ${updated.token}.`,
    };
  },
});

export const generationUploadTools = [
  listModels,
  getShotVariantGrid,
  generateShotImageTool,
  generateShotImageVariantsTool,
  selectShotImageVariantTool,
  generateShotVideoTool,
  cancelVideoRenderTool,
  renderShotAtQualityTool,
  renderSequenceDraftsAtQualityTool,
  addModelToSequenceTool,
  selectSequenceModelTool,
  uploadMediaTool,
  setShotImageFromUploadTool,
  setShotVideoFromUploadTool,
  setMusicFromUploadTool,
  setCharacterSheetFromUploadTool,
  setLocationSheetFromUploadTool,
  addElementTool,
  replaceElementTool,
];
