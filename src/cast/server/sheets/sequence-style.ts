import { resolveSequenceStyleConfig } from '@/look/style-config';
import type { StoredStyleConfig, StyleConfig } from '@/look/style-config';
import type { ScopedDb } from '@/platform/server/db/scoped';

type StyleSequence = {
  styleId: string | null;
  styleConfig: Parameters<typeof resolveSequenceStyleConfig>[0]['snapshot'];
};

/**
 * The style a sequence renders with: its own snapshot, else the live catalog
 * row, else none. A sheet no longer reads it (#2017, `rendering`); the
 * verify of a digest stamped before that still does.
 */
export async function resolveSequenceStyle(
  scopedDb: Pick<ScopedDb, 'styles'>,
  sequence: StyleSequence
): Promise<StyleConfig | undefined> {
  const style =
    sequence.styleConfig == null && sequence.styleId
      ? await scopedDb.styles.getById(sequence.styleId)
      : null;
  return sequenceStyleFromRow(sequence, style);
}

/** `resolveSequenceStyle` with the catalog row already read (#2082). */
export function sequenceStyleFromRow(
  sequence: StyleSequence,
  style: { config: StoredStyleConfig } | null | undefined
): StyleConfig | undefined {
  return sequence.styleConfig != null || style
    ? resolveSequenceStyleConfig({
        snapshot: sequence.styleConfig,
        live: style?.config,
      })
    : undefined;
}
