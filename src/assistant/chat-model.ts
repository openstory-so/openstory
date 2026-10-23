/**
 * Which model answers a chat turn (#2155). The user picks one in the
 * composer; the pick rides in `forwardedProps.model`. Anything that is not
 * a selectable analysis model falls back to the default, and a vendor the
 * request's country cannot reach is swapped the way sequences swap it.
 */
import {
  DEFAULT_ANALYSIS_MODEL,
  isSelectableAnalysisModelId,
  type AnalysisModelId,
} from '@/models/models.config';
import { resolveModelForCountry } from '@/models/region-policy';

export function chatModelFor(
  requested: unknown,
  country: string | null | undefined
): AnalysisModelId {
  const model = isSelectableAnalysisModelId(requested)
    ? requested
    : DEFAULT_ANALYSIS_MODEL;
  return resolveModelForCountry(model, country);
}
