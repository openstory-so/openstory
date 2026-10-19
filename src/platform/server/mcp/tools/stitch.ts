/**
 * MCP: share a stitch (#2127) without the CLI. The adapter over
 * `createStitchFromSources` in `src/stitches/server/create-stitch.ts`.
 */

import { PORTRAIT_RIGHTS_V1 } from '@/platform/compliance/attestations';
import { MAX_INLINE_UPLOAD_BYTES } from '@/shots/server/media-upload';
import {
  createStitchFromSources,
  stitchSourcesCutSchema,
} from '@/stitches/server/create-stitch';
import { z } from 'zod';
import { openstoryTool } from '../tool-context';

const createStitchTool = openstoryTool({
  name: 'create_stitch',
  description: `Share a cut as a public page anyone can watch: stills, dialogue, music and video clips played as one sequence by the stitch player. Same shape as npx @openstory/stitch (use that command when the files are on disk). Each media slot is { url } (a public http(s) link the server fetches; use this for clips) or { data, mimeType } (base64, at most ${MAX_INLINE_UPLOAD_BYTES / 1024 / 1024} MB decoded; fine for a still or a line). A video clip is { videoUrl, posterUrl, cues } and plays the sound in its file. A still is { imageUrl, fallbackImageUrl, durationSeconds, audioUrls, width, height, cues }: audioUrls play back to back and the still holds for the longer of durationSeconds and that sound. cues are subtitles in seconds from the clip's start. frameWidth and frameHeight are the shape of the page; musicUrl is a bed under the whole cut and musicGainDb adjusts only that bed, in dB (0 leaves it as recorded). Every image is checked for a real person; one who is needs portraitAttestation. Returns url, the page to send.`,
  scope: 'sequences:write',
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.strictObject({
    cut: stitchSourcesCutSchema,
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
  }),
  outputSchema: z.object({
    id: z.string(),
    url: z.string(),
    files: z.number(),
  }),
  run: async (input, { scopedDb, userId, origin, request }) => {
    const { id, files } = await createStitchFromSources({
      scopedDb,
      userId,
      cut: input.cut,
      portraitAttestation: input.portraitAttestation,
      request,
    });
    const url = new URL(`/stitch/${id}`, origin).href;
    return {
      data: { id, url, files },
      summary: `Shared the stitch at ${url}.`,
    };
  },
});

export const stitchTools = [createStitchTool];
