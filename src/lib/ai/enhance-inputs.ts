/**
 * Shared construction of the style/element inputs the script enhancer reads, so
 * the UI (`enhanceScriptStreamFn`) and the public API (`runOneShotCreate`) feed
 * the enhancer IDENTICALLY (issue #855). Runtime deps are limited to the
 * client-safe logger (type-only import of StyleConfig otherwise) so this stays
 * safe to import from the client bundle.
 */
import { getLogger } from '@/lib/observability/logger';
import { parseStyleConfig, type StyleConfig } from '@/lib/style/style-config';

const logger = getLogger(['openstory', 'ai', 'enhance-inputs']);

/**
 * A style as the enhancer sees it: the aesthetic recipe (`config`) plus the
 * identity that drives WHAT HAPPENS — name/category/tags decide whether "action"
 * gets a chase and "rom-com" gets a meet-cute, not just how the shot looks.
 * One cohesive narrowing of a `Style` row rather than two parallel bags.
 *
 * `config` is whole-or-absent (a parsed v2 `StyleConfig`, never partial) and
 * `tags` is always an array, so consumers need no per-field or `?.length`
 * guards on the core.
 */
export type EnhanceStyle = {
  config?: StyleConfig;
  name?: string;
  category?: string | null;
  description?: string | null;
  tags: string[];
};

/**
 * A style row, narrowed to the fields the enhancer reads. `config` is the raw
 * stored blob (v1 or v2) — `toEnhanceInputs` up-converts it.
 */
type StyleLike = {
  config?: unknown;
  name?: string | null;
  category?: string | null;
  description?: string | null;
  tags?: string[] | null;
};

/**
 * An ingested element, narrowed to the fields the enhancer reads. Satisfied by
 * the create-flow drafts (`DraftElementUpload` / `TempElementUpload`, which
 * carry `tempPublicUrl`) AND by persisted `SequenceElement` rows when enhancing
 * an existing sequence (which carry `imageUrl`).
 */
type ElementLike = {
  token?: string | null;
  /** Create-flow draft upload URL. */
  tempPublicUrl?: string | null;
  /** Persisted sequence-element image URL (enhance-on-existing-sequence). */
  imageUrl?: string | null;
  description?: string | null;
};

/** The enhancer's element shape: an UPPERCASE token + an image to look at. */
type EnhanceElement = {
  token: string;
  imageUrl: string;
  description?: string;
};

/**
 * Narrow a style row + ingested elements to the enhancer inputs. Spread the
 * result into the enhance request so both call sites stay in lockstep.
 */
export function toEnhanceInputs(args: {
  style?: StyleLike | null;
  elements?: readonly ElementLike[] | null;
}): {
  style?: EnhanceStyle;
  elements?: EnhanceElement[];
} {
  const { style, elements } = args;
  // An element can be woven into the script only if it has BOTH a token (the
  // script reference) and an image URL (draft `tempPublicUrl` or persisted
  // `imageUrl`). Drop the rest.
  const dropped: string[] = [];
  const mapped = (elements ?? []).flatMap((el): EnhanceElement[] => {
    const imageUrl = el.tempPublicUrl ?? el.imageUrl;
    if (!el.token || !imageUrl) {
      dropped.push(el.token ?? '(untokened)');
      return [];
    }
    return [
      {
        token: el.token,
        imageUrl,
        ...(el.description ? { description: el.description } : {}),
      },
    ];
  });

  if (dropped.length > 0) {
    // The user attached these elements but they can't be woven in (no token or
    // no reference image). Surface it so "my reference image was ignored" is
    // diagnosable instead of silent.
    logger.warn(
      'enhance-inputs dropped {count} element(s) missing token/image: {tokens}',
      { count: dropped.length, tokens: dropped.join(', ') }
    );
  }

  return {
    style: style
      ? {
          // Up-convert the stored blob here so everything downstream (wire
          // schema, prompt builder) sees exactly one shape. Throws loudly on a
          // corrupt blob — that's data corruption, not an input to tolerate.
          config: style.config ? parseStyleConfig(style.config) : undefined,
          name: style.name ?? undefined,
          category: style.category ?? null,
          description: style.description ?? null,
          tags: style.tags ?? [],
        }
      : undefined,
    elements: mapped.length > 0 ? mapped : undefined,
  };
}
