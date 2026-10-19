import { NotFoundError } from '@/platform/errors';
import { isValidId } from '@/platform/id';
import { getPublicStitch } from '@/platform/server/db/scoped';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

/**
 * A shared stitch for its public page (#2127). No auth: the id is the link.
 * Only a published row is a page; one still uploading is not found.
 */
export const getStitchFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(z.object({ id: z.string().min(1).max(64) })))
  .handler(async ({ data }) => {
    const stitch = isValidId(data.id) ? await getPublicStitch(data.id) : null;
    if (!stitch) throw new NotFoundError('This stitch does not exist');
    return { cut: stitch.cut, createdAt: stitch.createdAt };
  });
