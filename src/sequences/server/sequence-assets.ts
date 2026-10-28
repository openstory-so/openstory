/**
 * Loads the rows the asset manifest reads and projects them (#2209).
 * Request-time only: a workflow must not call this. SQL stays in the
 * scoped-db modules named below.
 */
import { NotFoundError } from '@/platform/errors';
import type { VoicePreview } from '@/platform/server/db/schema';
import {
  projectSequenceAssets,
  type AssetScope,
  type SequenceAsset,
  type SequenceAssetSource,
  type SequenceAssetsBody,
} from '@/sequences/sequence-assets';

type Stored = {
  id: string;
  url: string | null;
  storagePath: string | null;
  status: string;
  discardedAt: Date | null;
};

/** The scoped reads the manifest uses. A real `scopedDb` satisfies this. */
export type SequenceAssetDb = {
  sequences: {
    getById(sequenceId: string): Promise<{
      id: string;
      title: string;
      script: string | null;
      styleId: string;
      selectedMusicVariantId: string | null;
    } | null>;
  };
  scenes: {
    listBySequence(
      sequenceId: string
    ): Promise<{ id: string; orderIndex: number }[]>;
  };
  shots: {
    listBySequence(sequenceId: string): Promise<
      {
        id: string;
        sceneId: string | null;
        shotNumber: number | null;
        renderSegmentId: string | null;
      }[]
    >;
  };
  frames: {
    listBySequence(
      sequenceId: string
    ): Promise<
      { id: string; shotId: string; selectedImageVersionId: string | null }[]
    >;
  };
  frameVariants: {
    listStoredBySequence(
      sequenceId: string,
      options?: { includeDiscarded?: boolean }
    ): Promise<(Stored & { frameId: string; kind: string })[]>;
  };
  renderSegments: {
    listBySequence(
      sequenceId: string
    ): Promise<{ id: string; selectedVideoVersionId: string | null }[]>;
  };
  videoVariants: {
    listStoredBySequence(
      sequenceId: string,
      options?: { includeDiscarded?: boolean }
    ): Promise<(Stored & { renderSegmentId: string })[]>;
  };
  characters: {
    list(sequenceId: string): Promise<
      {
        id: string;
        name: string;
        looks: {
          id: string;
          name: string;
          deletedAt: Date | null;
          isDefault: boolean;
          selectedSheetVersionId: string | null;
          sheetImageUrl: string | null;
          sheetImagePath: string | null;
          sheetPortraitUrl: string | null;
        }[];
      }[]
    >;
    listVoiceTakesBySequence(sequenceId: string): Promise<
      {
        id: string;
        characterId: string;
        previews: VoicePreview[];
        status: string;
        released: boolean;
        selected: boolean;
      }[]
    >;
  };
  characterSheetVariants: {
    listStoredByCharacterIds(
      characterIds: string[],
      options?: { includeDiscarded?: boolean }
    ): Promise<
      (Stored & {
        characterId: string;
        lookId: string | null;
        portraitUrl: string | null;
      })[]
    >;
  };
  locations: {
    list(sequenceId: string): Promise<
      {
        id: string;
        name: string;
        selectedReferenceVersionId: string | null;
        referenceImageUrl: string | null;
        referenceImagePath: string | null;
        referencePortraitUrl: string | null;
      }[]
    >;
    listPhotosByLocationIds(
      ids: string[]
    ): Promise<{ id: string; locationId: string; url: string; path: string }[]>;
  };
  locationSheetVariants: {
    listStoredByLocationIds(
      locationIds: string[],
      options?: { includeDiscarded?: boolean }
    ): Promise<(Stored & { locationId: string; portraitUrl: string | null })[]>;
  };
  sequenceElements: {
    list(sequenceId: string): Promise<
      {
        id: string;
        token: string;
        imageUrl: string | null;
        imagePath: string | null;
      }[]
    >;
  };
  shotDialogue: {
    listSpeechesBySequence(
      sequenceId: string
    ): Promise<{ id: string; url: string; storageKey: string }[]>;
    listSectionsBySequence(sequenceId: string): Promise<
      {
        shotId: string;
        speechId: string;
        fromSeconds: number;
        toSeconds: number;
        selected: boolean;
      }[]
    >;
  };
  sequenceVariants: {
    listMusicBySequence(
      sequenceId: string,
      options?: { includeDiscarded?: boolean }
    ): Promise<Stored[]>;
  };
  shotPromptVersions: {
    listSelectedMotionBySequence(
      sequenceId: string
    ): Promise<{ id: string; shotId: string; text: string }[]>;
  };
  styles: {
    getById(styleId: string): Promise<{
      id: string;
      previewUrl: string | null;
      sampleVideos: { url: string; order: number }[] | null;
    } | null>;
  };
  sequenceExports: {
    listBySequence(
      sequenceId: string
    ): Promise<{ id: string; url: string; storagePath: string }[]>;
  };
};

export async function listSequenceAssets(
  db: SequenceAssetDb,
  sequenceId: string,
  options: { scope: AssetScope; includeExports: boolean }
): Promise<SequenceAssetsBody> {
  const sequence = await db.sequences.getById(sequenceId);
  if (!sequence) throw new NotFoundError('Sequence not found');
  const includeDiscarded = options.scope === 'history';
  const [
    scenes,
    shots,
    frames,
    stills,
    segments,
    videos,
    characters,
    locations,
    elements,
    speeches,
    sections,
    music,
    prompts,
    style,
    voiceTakes,
    exports,
  ] = await Promise.all([
    db.scenes.listBySequence(sequenceId),
    db.shots.listBySequence(sequenceId),
    db.frames.listBySequence(sequenceId),
    db.frameVariants.listStoredBySequence(sequenceId, { includeDiscarded }),
    db.renderSegments.listBySequence(sequenceId),
    db.videoVariants.listStoredBySequence(sequenceId, { includeDiscarded }),
    db.characters.list(sequenceId),
    db.locations.list(sequenceId),
    db.sequenceElements.list(sequenceId),
    db.shotDialogue.listSpeechesBySequence(sequenceId),
    db.shotDialogue.listSectionsBySequence(sequenceId),
    db.sequenceVariants.listMusicBySequence(sequenceId, { includeDiscarded }),
    db.shotPromptVersions.listSelectedMotionBySequence(sequenceId),
    db.styles.getById(sequence.styleId),
    db.characters.listVoiceTakesBySequence(sequenceId),
    options.includeExports
      ? db.sequenceExports.listBySequence(sequenceId)
      : Promise.resolve([]),
  ]);
  const [sheets, locationSheets, photos] = await Promise.all([
    db.characterSheetVariants.listStoredByCharacterIds(
      characters.map((character) => character.id),
      { includeDiscarded }
    ),
    db.locationSheetVariants.listStoredByLocationIds(
      locations.map((location) => location.id),
      { includeDiscarded }
    ),
    db.locations.listPhotosByLocationIds(
      locations.map((location) => location.id)
    ),
  ]);
  const source: SequenceAssetSource = {
    sequence,
    scenes,
    shots: shots.flatMap((shot) =>
      shot.sceneId == null
        ? []
        : [
            {
              id: shot.id,
              sceneId: shot.sceneId,
              shotNumber: shot.shotNumber,
              renderSegmentId: shot.renderSegmentId,
            },
          ]
    ),
    frames,
    stills,
    segments,
    videos,
    characters: characters.map((character) => ({
      id: character.id,
      name: character.name,
      looks: character.looks.map((look) => ({
        id: look.id,
        name: look.name,
        deleted: look.deletedAt != null,
        isDefault: look.isDefault,
        selectedSheetVersionId: look.selectedSheetVersionId,
        sheetImageUrl: look.sheetImageUrl,
        sheetImagePath: look.sheetImagePath,
        sheetPortraitUrl: look.sheetPortraitUrl,
      })),
    })),
    sheets,
    voiceTakes: voiceTakes.map((take) => ({
      id: take.id,
      characterId: take.characterId,
      selected: take.selected,
      status: take.status,
      released: take.released,
      previews: take.previews,
    })),
    locations,
    locationSheets,
    photos,
    elements,
    speeches,
    sections,
    music,
    selectedMusicVariantId: sequence.selectedMusicVariantId,
    prompts,
    style: style
      ? {
          id: style.id,
          previewUrl: style.previewUrl,
          sampleVideos: style.sampleVideos ?? [],
        }
      : null,
    exports,
  };
  const assets: SequenceAsset[] = projectSequenceAssets(source, options);
  return {
    sequenceId: sequence.id,
    title: sequence.title,
    scope: options.scope,
    includeExports: options.includeExports,
    assets,
  };
}
