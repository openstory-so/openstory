/**
 * Provenance of the references a clip was rendered from (#1657).
 *
 * Reference sheets and element media are not versioned inputs on the motion
 * prompt — they bind on the clip, like a character sheet on a still. Until
 * now the manifest recorded none of them, so selecting a new sheet version
 * or replacing an element's clip never flagged the render (the red edges on
 * the docs dependency graph). Each reference the render is sent now carries a
 * key naming the entity and the identity of what was sent; the manifest
 * stores the sorted set and staleness looks each entity up live.
 *
 * `identity` is the selected version id when the entity has one, otherwise
 * the URL: a sheet re-select or a re-upload both move it, a rename does not.
 */

export type ReferenceEntityKind = 'character' | 'location' | 'element';

export function referenceProvenanceKey(
  kind: ReferenceEntityKind,
  entityId: string,
  identity: string | null | undefined
): string {
  return `${kind}:${entityId}:${identity ?? ''}`;
}

/** `kind:entityId` — what the live lookup is keyed on. */
function referenceEntityKey(key: string): string {
  const [kind, entityId] = key.split(':', 2);
  return `${kind}:${entityId}`;
}

/** The sorted, de-duplicated keys of every reference that carries one. */
export function referenceKeysFrom(
  refs: ReadonlyArray<{ provenanceKey?: string }> | null | undefined
): string[] {
  const keys = new Set<string>();
  for (const ref of refs ?? []) {
    if (ref.provenanceKey) keys.add(ref.provenanceKey);
  }
  return [...keys].sort();
}

/**
 * Live identity per entity (`kind:entityId` → what a render would be sent
 * NOW), built from the rows the reference builders read.
 */
export function liveReferenceIdentity(input: {
  characters: ReadonlyArray<{
    id: string;
    selectedSheetVersionId: string | null;
    sheetImageUrl: string | null;
  }>;
  locations: ReadonlyArray<{
    id: string;
    selectedReferenceVersionId: string | null;
    referenceImageUrl: string | null;
  }>;
  elements: ReadonlyArray<{ id: string; imageUrl: string | null }>;
}): Map<string, string> {
  const live = new Map<string, string>();
  for (const c of input.characters) {
    live.set(
      `character:${c.id}`,
      referenceProvenanceKey(
        'character',
        c.id,
        c.selectedSheetVersionId ?? c.sheetImageUrl
      )
    );
  }
  for (const l of input.locations) {
    live.set(
      `location:${l.id}`,
      referenceProvenanceKey(
        'location',
        l.id,
        l.selectedReferenceVersionId ?? l.referenceImageUrl
      )
    );
  }
  for (const e of input.elements) {
    live.set(
      `element:${e.id}`,
      referenceProvenanceKey('element', e.id, e.imageUrl)
    );
  }
  return live;
}

/**
 * True when any stamped reference no longer matches what its entity would
 * send now (re-selected sheet, re-uploaded media, or the entity is gone).
 * An absent stamp (rows from before #1657) is unknown, never stale.
 */
export function referenceKeysMoved(
  stamped: readonly string[] | undefined,
  live: ReadonlyMap<string, string>
): boolean {
  if (!stamped) return false;
  return stamped.some((key) => live.get(referenceEntityKey(key)) !== key);
}
