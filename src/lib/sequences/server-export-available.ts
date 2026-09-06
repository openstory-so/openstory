/**
 * Can this worker actually run a server-side sequence export?
 *
 * True when the production or PR-preview `VIDEO_EXPORT_CONTAINER` binding is
 * present, or when local dev has pointed the workflow at `bun dev:bunny` via
 * `VIDEO_EXPORT_DEV_URL`. False on plain `bun dev` and hermetic e2e — theatre
 * then toasts rather than encoding in the browser.
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
