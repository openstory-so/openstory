import { describeUpload } from '@/cast/server/describe-upload';
import { authWithOrganizationMiddleware } from '@/platform/middleware.fn';
import { mediaUrlSchema } from '@/platform/schemas/media-url.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

/** Describe a checked character or location upload (#2254) to fill its form. */
export const describeUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithOrganizationMiddleware])
  .validator(
    zodValidator(
      z.object({
        url: mediaUrlSchema,
        filename: z.string().min(1),
        subject: z.enum(['character', 'location']),
      })
    )
  )
  .handler(({ context, data }) =>
    describeUpload({
      scopedDb: context.scopedDb,
      userId: context.user.id,
      ...data,
    })
  );
