import { NotFoundError } from '@/platform/errors';
import { getPublicStitch } from '@/platform/server/db/scoped';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

/** A shared stitch for its public page (#2127). No auth: the id is the link. */
export const getStitchFn = createServerFn({ method: 'GET' })
  .validator(zodValidator(z.object({ id: z.string().min(1).max(64) })))
  .handler(async ({ data }) => {
    const stitch = await getPublicStitch(data.id);
    if (!stitch) throw new NotFoundError('This stitch does not exist');
    return { cut: stitch.cut, createdAt: stitch.createdAt };
  });
