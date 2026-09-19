import { NotFoundError } from '@/platform/errors';
import type { ScopedDb } from '@/platform/server/db/scoped';
import { dbSceneId } from '@/shots/scene-id';

type Owned = { sequenceId: string; deletedAt?: Date | null };

/**
 * The one parent-chain authorisation for id-addressed production reads.
 *
 * Most per-table reads (`frameVariants.listByFrame`, `shots.getById`, …) carry
 * no team filter: the editor's server fns load the sequence first and only then
 * follow ids. A caller that takes raw ids from outside (MCP) calls this before
 * the same reads. Every check starts at `sequences.getById`, which IS
 * team-scoped, and walks down: a row must belong to that sequence, be live, and
 * hang off a live parent.
 */
export function productionAccess(scopedDb: ScopedDb) {
  function owned<T extends Owned>(
    row: T | null | undefined,
    sequenceId: string,
    what: string
  ): T {
    if (!row || row.sequenceId !== sequenceId || row.deletedAt)
      throw new NotFoundError(`${what} not found in this sequence.`);
    return row;
  }
  async function sequence(id: string) {
    const row = await scopedDb.sequences.getById(id);
    if (!row) throw new NotFoundError('Sequence not found.');
    return row;
  }
  const sceneIn = async (sequenceId: string, id: string) =>
    owned(await scopedDb.scenes.getById(dbSceneId(id)), sequenceId, 'Scene');
  async function shotIn(sequenceId: string, id: string) {
    const row = owned(await scopedDb.shots.getById(id), sequenceId, 'Shot');
    // A legacy scene-less shot is visible; a shot under a deleted scene is not.
    if (row.sceneId)
      owned(
        await scopedDb.scenes.getById(dbSceneId(row.sceneId)),
        sequenceId,
        'Shot'
      );
    return row;
  }
  return {
    sequence,
    async scene(sequenceId: string, id: string) {
      await sequence(sequenceId);
      return sceneIn(sequenceId, id);
    },
    async shot(sequenceId: string, id: string) {
      await sequence(sequenceId);
      return shotIn(sequenceId, id);
    },
    async frame(sequenceId: string, id: string) {
      await sequence(sequenceId);
      const row = owned(await scopedDb.frames.getById(id), sequenceId, 'Frame');
      await shotIn(sequenceId, row.shotId);
      return row;
    },
    async segment(sequenceId: string, id: string) {
      await sequence(sequenceId);
      const row = owned(
        await scopedDb.renderSegments.getById(id),
        sequenceId,
        'Render segment'
      );
      await sceneIn(sequenceId, row.sceneId);
      return row;
    },
    async character(sequenceId: string, id: string) {
      await sequence(sequenceId);
      return owned(
        await scopedDb.characters.getById(id),
        sequenceId,
        'Character'
      );
    },
    async location(sequenceId: string, id: string) {
      await sequence(sequenceId);
      return owned(
        await scopedDb.sequenceLocations.getById(id),
        sequenceId,
        'Location'
      );
    },
    async element(sequenceId: string, id: string) {
      await sequence(sequenceId);
      return owned(
        await scopedDb.sequenceElements.getById(id),
        sequenceId,
        'Element'
      );
    },
  };
}
