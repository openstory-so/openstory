/**
 * MCP tools for the Studio (#1985), the standalone image and video
 * generator: create, edit, render a draft at quality, favourite, delete,
 * draft a prompt and read a clip's edit history. Each calls the function
 * `studio-assets.fn.ts` calls; MCP adds only the URL normalising below.
 */
import { z } from 'zod';
import { aspectRatioSchema } from '@/models/aspect-ratios';
import { resolutionSchema } from '@/models/resolutions';
import { ValidationError } from '@/platform/errors';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import { fromShareableUrl } from '@/platform/server/storage/buckets';
import {
  studioActivitySchema,
  studioCreateInputSchema,
  studioPromptDraftInputSchema,
} from '@/studio/schema';
import {
  createStudioAssets,
  editStudioAsset,
  renderStudioAssetAtQuality,
} from '@/studio/server/create-studio-asset';
import {
  deleteStudioAsset,
  draftStudioPromptForTeam,
  getStudioEditHistory,
  setStudioAssetFavorite,
} from '@/studio/server/studio-asset-actions';
import { openstoryTool, productionRead } from '../tool-context';

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};
/** Starts paid provider work. */
const paid = { ...writeAnnotations, openWorldHint: true };

const assetId = ulidSchema.describe(
  'Studio asset ID (list_generated_assets source studio).'
);
const mediaRef = z
  .string()
  .min(1)
  .max(2048)
  .describe(
    'An upload value (upload_media use studio), or a media URL read from list_studio_uploads or get_generated_asset.'
  );
const startedSchema = z.object({
  assets: z.array(z.object({ id: z.string(), workflowRunId: z.string() })),
});
const pollHint =
  'Poll get_generated_asset with each id until status is completed or failed.';

/** Fields that only a video takes; an image request carrying one is refused. */
const VIDEO_ONLY = [
  'videoModel',
  'duration',
  'generateAudio',
  'draft',
  'mode',
  'startImageUrl',
  'endImageUrl',
] as const;

const createStudioAssetsTool = openstoryTool({
  name: 'create_studio_assets',
  description: `Generate images or videos in the Studio (uses credits), up to 4 at once. activity image takes imageModel (list_models image with studio set) and optional referenceImages (when its studio.referenceImages). activity video takes videoModel (list_models video with studio set) and duration (one of its studio.durations), and mode: text (default), reference (referenceImages / referenceVideos / referenceAudio, named @Image1, @Video1, @Audio1 in the prompt, within the model's studio limits) or frames (startImageUrl, and endImageUrl when its studio.endFrame). draft renders a 480p Ark draft (draftMode models); render_studio_asset_at_quality makes its final. Images of a real person must be uploaded with the portrait sign-off first. ${pollHint}`,
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({
    activity: studioActivitySchema,
    prompt: z.string().max(50_000),
    imageModel: z.string().min(1).max(100).optional(),
    videoModel: z.string().min(1).max(100).optional(),
    aspectRatio: aspectRatioSchema,
    resolution: resolutionSchema.optional(),
    count: z.int().min(1).max(4).default(1),
    duration: z.union([z.number().positive(), z.literal('auto')]).optional(),
    generateAudio: z.boolean().optional(),
    draft: z.boolean().optional(),
    mode: z.enum(['text', 'reference', 'frames']).optional(),
    referenceImages: z.array(mediaRef).max(9).default([]),
    referenceVideos: z.array(mediaRef).max(3).default([]),
    referenceAudio: z.array(mediaRef).max(3).default([]),
    startImageUrl: mediaRef.optional(),
    endImageUrl: mediaRef.optional(),
  }),
  outputSchema: startedSchema,
  run: async (input, { scopedDb }) => {
    if (input.activity === 'image') {
      const extra = VIDEO_ONLY.find((key) => input[key] !== undefined);
      const refs = input.referenceVideos.length + input.referenceAudio.length;
      if (extra || refs > 0) {
        throw new ValidationError(
          `${extra ?? 'referenceVideos / referenceAudio'} applies to a video only.`
        );
      }
    }
    const result = await createStudioAssets(
      scopedDb,
      studioCreateInputSchema.parse({
        ...input,
        referenceImages: input.referenceImages.map(fromShareableUrl),
        referenceVideos: input.referenceVideos.map(fromShareableUrl),
        referenceAudio: input.referenceAudio.map(fromShareableUrl),
        startImageUrl:
          input.startImageUrl && fromShareableUrl(input.startImageUrl),
        endImageUrl: input.endImageUrl && fromShareableUrl(input.endImageUrl),
      })
    );
    const n = result.assets.length;
    return {
      data: result,
      summary: `Started ${n} ${input.activity}${n === 1 ? '' : 's'}.`,
    };
  },
});

const editStudioAssetTool = openstoryTool({
  name: 'edit_studio_asset',
  description: `Rewrite a finished Studio video from a prompt (uses credits): a new asset on Seedance 2.5 that keeps the clip's shape and length; the original stays. Only a Seedance clip not made from a reference video can be edited. draft renders the edit as a 480p Ark draft; an edit of a draft is always a draft. get_studio_edit_history lists the chain. ${pollHint}`,
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({
    id: assetId,
    prompt: z.string().trim().min(1).max(50_000),
    draft: z.boolean().default(false),
  }),
  outputSchema: startedSchema,
  run: async (input, { scopedDb }) => ({
    data: await editStudioAsset(scopedDb, input.id, input.prompt, input.draft),
    summary: 'Started the edit.',
  }),
});

const renderStudioAssetAtQualityTool = openstoryTool({
  name: 'render_studio_asset_at_quality',
  description: `Render a finished Studio Ark draft at 1080p (uses credits) as a new asset; the draft stays. Refused when the asset is not a finished draft or is over seven days old. ${pollHint}`,
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({ id: assetId }),
  outputSchema: startedSchema,
  run: async (input, { scopedDb }) => ({
    data: await renderStudioAssetAtQuality(scopedDb, input.id),
    summary: 'Started the 1080p render.',
  }),
});

const setStudioAssetFavoriteTool = openstoryTool({
  name: 'set_studio_asset_favorite',
  description:
    'Mark a Studio asset as a favourite, or unmark it (list_generated_assets favoritesOnly reads them back).',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, idempotentHint: true },
  inputSchema: z.strictObject({ id: assetId, isFavorite: z.boolean() }),
  outputSchema: z.object({ id: z.string(), isFavorite: z.boolean() }),
  run: async (input, { scopedDb }) => ({
    data: await setStudioAssetFavorite(scopedDb, input.id, input.isFavorite),
    summary: input.isFavorite ? 'Favourited.' : 'Unfavourited.',
  }),
});

const deleteStudioAssetTool = openstoryTool({
  name: 'delete_studio_asset',
  description:
    'Delete a Studio asset and its files. It cannot be restored; confirm with the user first. Edits made from it stay.',
  scope: 'sequences:write',
  annotations: { ...writeAnnotations, destructiveHint: true },
  inputSchema: z.strictObject({ id: assetId }),
  outputSchema: z.object({ id: z.string() }),
  run: async (input, { scopedDb }) => ({
    data: await deleteStudioAsset(scopedDb, input.id),
    summary: 'Deleted the asset.',
  }),
});

const draftStudioPromptTool = openstoryTool({
  name: 'draft_studio_prompt',
  description:
    'Write a Studio prompt from the attached references with an AI model (uses credits unless the team has its own key). currentPrompt, when sent, is the brief it follows; with no references and no brief it invents one. Starts no generation; pass the prompt to create_studio_assets.',
  scope: 'generate',
  annotations: paid,
  inputSchema: z.strictObject({
    ...studioPromptDraftInputSchema.shape,
    references: z
      .array(
        z.strictObject({
          ...studioPromptDraftInputSchema.shape.references.unwrap().element
            .shape,
          url: mediaRef,
        })
      )
      .max(15)
      .default([]),
    startImageUrl: mediaRef.optional(),
    endImageUrl: mediaRef.optional(),
  }),
  outputSchema: z.object({ prompt: z.string() }),
  run: async (input, { scopedDb }) => ({
    data: await draftStudioPromptForTeam(
      scopedDb,
      studioPromptDraftInputSchema.parse({
        ...input,
        references: input.references.map((ref) => ({
          ...ref,
          url: fromShareableUrl(ref.url),
        })),
        startImageUrl:
          input.startImageUrl && fromShareableUrl(input.startImageUrl),
        endImageUrl: input.endImageUrl && fromShareableUrl(input.endImageUrl),
      })
    ),
    summary: 'Drafted a prompt.',
  }),
});

const getStudioEditHistoryTool = productionRead(
  'get_studio_edit_history',
  'Read the prompts a Studio clip was made from, oldest first: the original, then each edit (edit true) down to this clip. A deleted ancestor ends the list.',
  z.strictObject({ id: assetId }),
  z.object({
    history: z.array(
      z.object({
        id: z.string(),
        prompt: z.string(),
        modelName: z.string(),
        edit: z.boolean(),
        createdAt: z.string(),
      })
    ),
  }),
  async (input, { scopedDb }) => ({
    history: (await getStudioEditHistory(scopedDb, input.id)).map((entry) => ({
      ...entry,
      createdAt: entry.createdAt.toISOString(),
    })),
  })
);

export const studioTools = [
  createStudioAssetsTool,
  editStudioAssetTool,
  renderStudioAssetAtQualityTool,
  setStudioAssetFavoriteTool,
  deleteStudioAssetTool,
  draftStudioPromptTool,
  getStudioEditHistoryTool,
];
