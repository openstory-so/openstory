/** A reference-only shot's storyboard sketches (#2350). */
import { createServerFn } from '@tanstack/react-start';
import { shotAccessMiddleware } from '@/shots/shot-access.fn';
import {
  readShotStoryboard,
  regenerateShotStoryboard,
} from '@/shots/server/shot-preview';

export const getShotStoryboardFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .handler(({ context }) => readShotStoryboard(context));

export const regenerateShotStoryboardFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .handler(({ context }) => regenerateShotStoryboard(context));
