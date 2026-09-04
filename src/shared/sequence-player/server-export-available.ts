/**
 * Can this worker actually run a server-side sequence export?
 *
 * True when the production/PR-preview container binding is present, or when
 * local dev has pointed the workflow at `bun dev:bunny` via
 * `VIDEO_EXPORT_DEV_URL`. False on plain `bun dev` and hermetic e2e — the
 * theatre must then keep the #1397 encoder error rather than POSTing a job
 * that will fail in the workflow (#1402).
 */

import { getEnv } from '#env';

type ExportEnv = {
  VIDEO_EXPORT_CONTAINER?: unknown;
  VIDEO_EXPORT_DEV_URL?: string;
};

export function isServerExportAvailable(): boolean {
  const env = getEnv() as ReturnType<typeof getEnv> & ExportEnv;
  return Boolean(env.VIDEO_EXPORT_DEV_URL || env.VIDEO_EXPORT_CONTAINER);
}
