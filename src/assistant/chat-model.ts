/**
 * Which model answers a chat turn (#2155). The user picks one in the
 * composer; the pick rides in `forwardedProps.model`. No pick means the
 * default; a pick that is not a selectable analysis model is refused, since
 * the composer only ever sends a selectable one. A vendor the request's
 * country cannot reach is swapped the way sequences swap it.
 */
import {
  DEFAULT_ANALYSIS_MODEL,
  isSelectableAnalysisModelId,
  type AnalysisModelId,
} from '@/models/models.config';
import { resolveModelForCountry } from '@/models/region-policy';
import { ValidationError } from '@/platform/errors';

export function chatModelFor(
  requested: unknown,
  country: string | null | undefined
): AnalysisModelId {
  if (requested !== undefined && !isSelectableAnalysisModelId(requested)) {
    throw new ValidationError('model is not one the assistant can run on.');
  }
  return resolveModelForCountry(
    requested === undefined ? DEFAULT_ANALYSIS_MODEL : requested,
    country
  );
}
