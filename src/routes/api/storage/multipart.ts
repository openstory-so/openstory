import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  uploadPart,
} from '#storage';
import { authRequestMiddleware } from '@/functions/middleware';
import { handleApiError } from '@/shared/errors';
import { resolveUploadTarget } from '@/lib/storage/upload-target';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

/**
 * Multipart upload endpoint for payloads over Cloudflare's ~100MB single-body
 * limit (e.g. exported MP4s). The client (putToR2) splits the blob into parts
 * and drives this in three phases:
 *
 *   POST ?action=create   → { uploadId }
 *   PUT  ?uploadId&partNumber  (body = part bytes) → { part: {partNumber, etag} }
 *   POST ?action=complete ?uploadId  (body = { parts })  → { publicUrl }
 *   POST ?action=abort    ?uploadId   (cleanup on failure)
 *
 * Every phase re-validates the team-scoped target via resolveUploadTarget, the
 * same check the single-shot upload route uses.
 */

const completePartsSchema = z.object({
  parts: z
    .array(
      z.object({
        partNumber: z.number().int().positive(),
        etag: z.string().min(1),
      })
    )
    .min(1),
});

export const Route = createFileRoute('/api/storage/multipart')({
  server: {
    middleware: [authRequestMiddleware],
    handlers: {
      // create | complete | abort — selected by ?action=
      POST: async ({ request, context }) => {
        try {
          const resolved = await resolveUploadTarget(request, context.user);
          if (!resolved.ok) return resolved.response;
          const { bucket, path, contentType } = resolved.target;
          const url = new URL(request.url);
          const action = url.searchParams.get('action');

          if (action === 'create') {
            const { uploadId } = await createMultipartUpload(
              bucket,
              path,
              contentType
            );
            return Response.json({ success: true, uploadId });
          }

          const uploadId = url.searchParams.get('uploadId');
          if (!uploadId) {
            return Response.json(
              { success: false, error: 'Missing uploadId' },
              { status: 400 }
            );
          }

          if (action === 'complete') {
            const parsed = completePartsSchema.safeParse(await request.json());
            if (!parsed.success) {
              return Response.json(
                { success: false, error: 'Invalid parts payload' },
                { status: 400 }
              );
            }
            const result = await completeMultipartUpload(
              bucket,
              path,
              uploadId,
              parsed.data.parts
            );
            return Response.json({
              success: true,
              publicUrl: result.publicUrl,
            });
          }

          if (action === 'abort') {
            await abortMultipartUpload(bucket, path, uploadId);
            return Response.json({ success: true });
          }

          return Response.json(
            { success: false, error: `Unknown action: ${action}` },
            { status: 400 }
          );
        } catch (error) {
          const handledError = handleApiError(error);
          return Response.json(
            { success: false, error: handledError.toJSON() },
            { status: handledError.statusCode }
          );
        }
      },

      // Upload a single part. Streamed via FixedLengthStream so a part is never
      // fully buffered in Worker memory (same rationale as the single upload).
      PUT: async ({ request, context }) => {
        try {
          const resolved = await resolveUploadTarget(request, context.user);
          if (!resolved.ok) return resolved.response;
          const { bucket, path } = resolved.target;

          const url = new URL(request.url);
          const uploadId = url.searchParams.get('uploadId');
          const partNumberRaw = url.searchParams.get('partNumber');
          const partNumber = partNumberRaw
            ? Number.parseInt(partNumberRaw, 10)
            : Number.NaN;
          if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1) {
            return Response.json(
              {
                success: false,
                error: 'Missing or invalid uploadId / partNumber',
              },
              { status: 400 }
            );
          }

          const body = request.body;
          if (!body) {
            return Response.json(
              { success: false, error: 'Request body is empty' },
              { status: 400 }
            );
          }
          const contentLengthHeader = request.headers.get('content-length');
          const contentLength = contentLengthHeader
            ? Number.parseInt(contentLengthHeader, 10)
            : Number.NaN;
          if (!Number.isFinite(contentLength) || contentLength <= 0) {
            return Response.json(
              {
                success: false,
                error: 'Content-Length header required for upload',
              },
              { status: 411 }
            );
          }

          const fixedLength = new FixedLengthStream(contentLength);
          body.pipeTo(fixedLength.writable).catch(() => {
            // Surfaces through the readable side and rejects uploadPart below.
          });
          const part = await uploadPart(
            bucket,
            path,
            uploadId,
            partNumber,
            fixedLength.readable
          );
          return Response.json({ success: true, part });
        } catch (error) {
          const handledError = handleApiError(error);
          return Response.json(
            { success: false, error: handledError.toJSON() },
            { status: handledError.statusCode }
          );
        }
      },
    },
  },
});
