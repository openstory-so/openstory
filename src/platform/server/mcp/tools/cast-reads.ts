import { z } from 'zod';
import { ulidSchema } from '@/platform/server/schemas/id.schemas';
import {
  characterReadSchema,
  locationReadSchema,
  elementReadSchema,
  listCharacters,
  readCharacter,
  listLocations,
  readLocation,
  listElements,
  readElement,
} from '@/cast/server/production-inspection';
import {
  productionRead,
  collectionInput,
  sequenceInput,
} from '../tool-context';

export const castReadTools = [
  productionRead(
    'list_characters',
    'Page sequence characters by database ID, including selected reference sheets and voice assignments. Continue using nextCursor.',
    collectionInput,
    z.object({
      characters: z.array(characterReadSchema),
      nextCursor: z.string().nullable(),
    }),
    (input, { scopedDb, origin }) => listCharacters(scopedDb, input, origin)
  ),
  productionRead(
    'get_character',
    'Inspect a sequence character by database characterId, including appearance, performance, voice takes, first mention and selected sheet. characterId is not an analysis label.',
    sequenceInput.extend({ characterId: ulidSchema }),
    z.object({ character: characterReadSchema }),
    async (input, { scopedDb, origin }) => ({
      character: await readCharacter(
        scopedDb,
        input.sequenceId,
        input.characterId,
        origin
      ),
    })
  ),
  productionRead(
    'list_locations',
    'Page the locations a sequence uses by database ID with design details and selected references. Each is one of the team’s locations (list_library_locations), read at its current bible and sheet; locationId is the sequence’s script token (loc_*) and attached says the writer picked it. Continue using nextCursor.',
    collectionInput,
    z.object({
      locations: z.array(locationReadSchema),
      nextCursor: z.string().nullable(),
    }),
    (input, { scopedDb, origin }) => listLocations(scopedDb, input, origin)
  ),
  productionRead(
    'get_location',
    'Inspect a location a sequence uses by database locationId (the same id list_library_locations gives, not the loc_* token), including its bible, rendering, first mention in this sequence and selected reference. The bible and sheet are the team’s, shared by every sequence that uses it.',
    sequenceInput.extend({ locationId: ulidSchema }),
    z.object({ location: locationReadSchema }),
    async (input, { scopedDb, origin }) => ({
      location: await readLocation(
        scopedDb,
        input.sequenceId,
        input.locationId,
        origin
      ),
    })
  ),
  productionRead(
    'list_elements',
    'Page sequence image, video and audio elements by database ID, including script tokens and media URLs. Continue using nextCursor.',
    collectionInput,
    z.object({
      elements: z.array(elementReadSchema),
      nextCursor: z.string().nullable(),
    }),
    (input, { scopedDb, origin }) => listElements(scopedDb, input, origin)
  ),
  productionRead(
    'get_element',
    'Inspect a sequence element by database elementId, including its token, description, media kind, duration and analysis status.',
    sequenceInput.extend({ elementId: ulidSchema }),
    z.object({ element: elementReadSchema }),
    async (input, { scopedDb, origin }) => ({
      element: await readElement(
        scopedDb,
        input.sequenceId,
        input.elementId,
        origin
      ),
    })
  ),
];
