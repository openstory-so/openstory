import { resolveSequenceStyleConfig } from '@/look/style-config';
import type { StyleConfig } from '@/look/style-config';
import type { ScopedDb } from '@/platform/server/db/scoped';

/**
 * The style a sequence renders with: its own snapshot, else the live catalog
 * row, else none. A sheet no longer reads it (#2017, `rendering`); the
 * verify of a digest stamped before that still does.
 */
export async function resolveSequenceStyle(
  scopedDb: Pick<ScopedDb, 'styles'>,
  sequence: {
    styleId: string | null;
    styleConfig: Parameters<typeof resolveSequenceStyleConfig>[0]['snapshot'];
  }
): Promise<StyleConfig | undefined> {
  const style =
    sequence.styleConfig == null && sequence.styleId
      ? await scopedDb.styles.getById(sequence.styleId)
      : null;
  return sequence.styleConfig != null || style
    ? resolveSequenceStyleConfig({
        snapshot: sequence.styleConfig,
        live: style?.config,
      })
    : undefined;
}
