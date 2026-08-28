/**
 * After scene-split, grow the run envelope to cover remaining stills/motion
 * (and music). If grow fails, do not spawn those children (#1310).
 */

import type { WorkflowScopedDb } from '@/lib/db/scoped-workflow';
import { getLogger } from '@/lib/observability/logger';
import { reportReservationShort } from './billing-observability';
import { type Microdollars, subtractMicros, ZERO_MICROS } from './money';

const logger = getLogger(['openstory', 'billing', 'storyboard-render-gate']);

export type StoryboardRenderGateResult =
  | { spawnRenders: true }
  | {
      spawnRenders: false;
      neededMicros: Microdollars;
      remainingMicros: Microdollars;
    };

export async function gateStoryboardRenders(opts: {
  scopedDb: WorkflowScopedDb;
  reservationId?: string;
  remainingWork: Microdollars;
  sceneCount: number;
  sequenceId?: string;
}): Promise<StoryboardRenderGateResult> {
  const { scopedDb, reservationId, remainingWork } = opts;
  if (!reservationId) return { spawnRenders: true };

  const peek = await scopedDb.billing.growReservation(
    reservationId,
    ZERO_MICROS
  );
  if (!peek.ok) {
    logger.warn('Storyboard reservation missing at render gate', {
      reservationId,
      sequenceId: opts.sequenceId,
    });
    reportReservationShort({
      teamId: scopedDb.teamId,
      sequenceId: opts.sequenceId,
      neededMicros: remainingWork,
      remainingMicros: ZERO_MICROS,
      sceneCount: opts.sceneCount,
    });
    void scopedDb.billing.checkAutoTopUp().catch((err) => {
      logger.error('Failed:', { err });
    });
    return {
      spawnRenders: false,
      neededMicros: remainingWork,
      remainingMicros: ZERO_MICROS,
    };
  }

  if (remainingWork <= peek.remaining) {
    return { spawnRenders: true };
  }

  const extra = subtractMicros(remainingWork, peek.remaining);
  const grown = await scopedDb.billing.growReservation(reservationId, extra);
  if (grown.ok) return { spawnRenders: true };

  reportReservationShort({
    teamId: scopedDb.teamId,
    sequenceId: opts.sequenceId,
    neededMicros: extra,
    remainingMicros: peek.remaining,
    sceneCount: opts.sceneCount,
  });
  await scopedDb.billing.zeroReservation(reservationId);
  void scopedDb.billing.checkAutoTopUp().catch((err) => {
    logger.error('Failed:', { err });
  });
  return {
    spawnRenders: false,
    neededMicros: extra,
    remainingMicros: peek.remaining,
  };
}
