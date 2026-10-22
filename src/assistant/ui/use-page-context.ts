/**
 * What the page says about itself (#2155), read off the router: the route
 * params name the sequence, character or location, the search params name
 * the selected scene or shot. Nothing is registered by pages, so a page
 * cannot forget to, and the chips update the moment the URL does. Labels
 * come from what the page already loaded into the query cache; an id whose
 * row is not cached yet is still sent, with a plain label.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useMatches } from '@tanstack/react-router';
import { teamCharacterKeys } from '@/cast/ui/use-team-characters';
import { teamLocationKeys } from '@/cast/ui/use-team-locations';
import { sequenceKeys } from '@/sequences/ui/use-sequences';
import { sceneKeys } from '@/shots/ui/use-scenes';
import { shotKeys } from '@/shots/ui/use-shots';
import { parseSelectionFromSearch } from '@/shots/ui/scene-selection';
import type { PageContextItem, PageContextKind } from '../page-context';

function field(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const found: unknown = Reflect.get(value, key);
  return typeof found === 'string' && found.length > 0 ? found : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function findInList(
  list: unknown,
  id: string
): Record<string, unknown> | undefined {
  if (!Array.isArray(list)) return undefined;
  const row: unknown = list.find((item) => field(item, 'id') === id);
  return isRecord(row) ? row : undefined;
}

export function usePageContext(): PageContextItem[] {
  const matches = useMatches();
  const queryClient = useQueryClient();
  const params: Record<string, string> = {};
  let search: Record<string, unknown> = {};
  let sequenceRoute = false;
  for (const match of matches) {
    Object.assign(params, match.params);
    search = { ...search, ...match.search };
    if (match.routeId.startsWith('/_app/sequences/$id')) sequenceRoute = true;
  }

  const items: PageContextItem[] = [];
  const push = (kind: PageContextKind, id: string, label: string) =>
    items.push({ kind, id, label });

  const sequenceId = sequenceRoute ? params.id : undefined;
  if (sequenceId) {
    const sequence = queryClient.getQueryData(sequenceKeys.detail(sequenceId));
    push('sequence', sequenceId, field(sequence, 'title') ?? 'This sequence');

    const selection = parseSelectionFromSearch({
      scenes: typeof search.scenes === 'string' ? search.scenes : undefined,
      shot: typeof search.shot === 'string' ? search.shot : undefined,
    });
    const shots = queryClient.getQueryData(shotKeys.list(sequenceId));
    const scenes = queryClient.getQueryData(sceneKeys.list(sequenceId));
    if (selection.shotId) {
      const shot = findInList(shots, selection.shotId);
      const sceneId = field(shot, 'sceneId');
      if (sceneId) {
        const scene = findInList(scenes, sceneId);
        push('scene', sceneId, field(scene, 'title') ?? 'This scene');
      }
      const number = shot?.shotNumber;
      push(
        'shot',
        selection.shotId,
        typeof number === 'number' ? `Shot ${number}` : 'This shot'
      );
    } else if (selection.sceneIds[0]) {
      const sceneId = selection.sceneIds[0];
      const scene = findInList(scenes, sceneId);
      push('scene', sceneId, field(scene, 'title') ?? 'This scene');
    }
  }

  const characterId =
    params.characterId ?? (sequenceRoute ? undefined : params.id);
  if (
    characterId &&
    (params.characterId ||
      matches.some((m) => m.routeId.startsWith('/_app/characters/')))
  ) {
    const character = queryClient.getQueryData(
      teamCharacterKeys.detail(characterId)
    );
    push(
      'character',
      characterId,
      field(character, 'name') ?? 'This character'
    );
  }

  if (params.locationId) {
    const location = queryClient.getQueryData(
      teamLocationKeys.detail(params.locationId)
    );
    push(
      'location',
      params.locationId,
      field(location, 'name') ?? 'This location'
    );
  }

  return items;
}
