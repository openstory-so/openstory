import { uploadFile } from '#storage';
import { authRequestMiddleware } from '@/functions/middleware';
import { handleApiError } from '@/shared/errors';
import { resolveUploadTarget } from '@/lib/storage/upload-target';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/storage/upload')({
  server: {
    middleware: [authRequestMiddleware],
    handlers: {
      PUT: async ({ request, context }) => {
        try {
          const resolved = await resolveUploadTarget(request, context.user);
          if (!resolved.ok) return resolved.response;
          const { bucket, path, contentType } = resolved.target;

          const body = request.body;
          if (!body) {
            return Response.json(
              { success: false, error: 'Request body is empty' },
              { status: 400 }
            );
          }

          // workerd's R2 binding rejects ReadableStreams without a known
          // length. The browser sends Content-Length (the body is a Blob),
          // but once `request.body` has been routed through TanStack Start
          // the length link is lost — so we re-establish it explicitly via
          // FixedLengthStream. See issue #738. Streaming (rather than
          // buffering) keeps the route within the 128MB Worker memory limit.
          //
          // NOTE: a single request body is capped at ~100MB by Cloudflare.
          // Larger uploads use the multipart route (/api/storage/multipart);
          // the client (putToR2) routes to it automatically by size.
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
            // Pipe errors (client disconnect, length mismatch) surface
            // through the readable side and reject the r2.put() below,
            // which the outer catch turns into a 5xx via handleApiError.
          });

          await uploadFile(bucket, path, fixedLength.readable, {
            contentType,
          });

          return Response.json({ success: true });
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
