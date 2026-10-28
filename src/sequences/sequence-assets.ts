/**
 * Sequence asset manifest (#2209). One list of the files a sequence can
 * download: the selected cut, or every completed stored version. The asset
 * page, the folder save and `npx @openstory/stitch pull` all write this
 * list. Text rows (script, prompt, dialogue cuts) carry `text` and no url.
 * File rows carry an origin-relative `/r2/…?download` url.
 *
 * Client-safe: no server imports. The loader in `server/sequence-assets.ts`
 * fills {@link SequenceAssetSource}.
 */
import { z } from 'zod';

export const assetScopeSchema = z.enum(['selected', 'history']);
export type AssetScope = z.infer<typeof assetScopeSchema>;

const sequenceAssetKindSchema = z.enum([
  'still',
  'video',
  'character_sheet',
  'character_portrait',
  'location_portrait',
  'voice',
  'location_sheet',
  'location_photo',
  'element',
  'dialogue',
  'dialogue_cuts',
  'music',
  'style',
  'prompt',
  'script',
  'export',
]);

export const sequenceAssetSchema = z
  .object({
    id: z.string(),
    kind: sequenceAssetKindSchema,
    role: z.string(),
    group: z.string(),
    label: z.string(),
    selected: z.boolean(),
    discarded: z.boolean(),
    shared: z.boolean(),
    relativePath: z.string(),
    url: z.string().nullable(),
    text: z.string().nullable(),
    contentType: z.string(),
    versionId: z.string(),
    owners: z.array(z.string()),
  })
  .meta({ id: 'SequenceAsset' });

export type SequenceAsset = z.infer<typeof sequenceAssetSchema>;

export const sequenceAssetsBodySchema = z.object({
  sequenceId: z.string(),
  title: z.string(),
  scope: assetScopeSchema,
  includeExports: z.boolean(),
  assets: z.array(sequenceAssetSchema),
});

export type SequenceAssetsBody = z.infer<typeof sequenceAssetsBodySchema>;

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
};

/** Origin-relative download url, or null when the bytes are not in our bucket. */
export function assetDownloadUrl(stored: {
  url: string | null;
  storagePath: string | null;
}): string | null {
  const path = stored.url?.startsWith('/r2/')
    ? stored.url.split('?')[0]
    : stored.storagePath
      ? `/r2/${stored.storagePath.replace(/^\/+/, '').replace(/^r2\//, '')}`
      : null;
  if (!path?.startsWith('/r2/') || path.includes('..')) return null;
  const parts = path.slice('/r2/'.length).split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null;
  }
  return `${path}?download`;
}

function fileExtension(
  url: string | null,
  storagePath: string | null,
  fallback: string
): string {
  const raw = (storagePath ?? url ?? '').split('?')[0] ?? '';
  const base = raw.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return fallback;
  const ext = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : fallback;
}

function contentTypeForExtension(ext: string): string {
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/** Changes when the text changes, so a second sync rewrites an edited sidecar. */
function textVersionId(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}

type StoredFile = {
  id: string;
  url: string | null;
  storagePath: string | null;
  status: string;
  discardedAt: Date | string | null;
};

export type SequenceAssetSource = {
  sequence: { id: string; title: string; script: string | null };
  scenes: { id: string; orderIndex: number }[];
  shots: {
    id: string;
    sceneId: string;
    shotNumber: number | null;
    renderSegmentId: string | null;
  }[];
  frames: {
    id: string;
    shotId: string;
    selectedImageVersionId: string | null;
  }[];
  stills: (StoredFile & { frameId: string; kind: string })[];
  segments: { id: string; selectedVideoVersionId: string | null }[];
  videos: (StoredFile & { renderSegmentId: string })[];
  characters: {
    id: string;
    name: string;
    looks: {
      id: string;
      name: string;
      deleted: boolean;
      isDefault: boolean;
      selectedSheetVersionId: string | null;
      sheetImageUrl: string | null;
      sheetImagePath: string | null;
      sheetPortraitUrl: string | null;
    }[];
  }[];
  sheets: (StoredFile & {
    characterId: string;
    lookId: string | null;
    portraitUrl: string | null;
  })[];
  voiceTakes: {
    id: string;
    characterId: string;
    selected: boolean;
    status: string;
    released: boolean;
    previews: {
      url: string | null;
      path: string | null;
      takeNumber?: number;
    }[];
  }[];
  locations: {
    id: string;
    name: string;
    selectedReferenceVersionId: string | null;
    referenceImageUrl: string | null;
    referenceImagePath: string | null;
    referencePortraitUrl: string | null;
  }[];
  locationSheets: (StoredFile & {
    locationId: string;
    portraitUrl: string | null;
  })[];
  photos: {
    id: string;
    locationId: string;
    url: string | null;
    path: string | null;
  }[];
  elements: {
    id: string;
    token: string;
    imageUrl: string | null;
    imagePath: string | null;
  }[];
  speeches: { id: string; url: string | null; storageKey: string | null }[];
  sections: {
    shotId: string;
    speechId: string;
    fromSeconds: number;
    toSeconds: number;
    selected: boolean;
  }[];
  music: StoredFile[];
  selectedMusicVariantId: string | null;
  prompts: { id: string; shotId: string; text: string }[];
  style: {
    id: string;
    previewUrl: string | null;
    sampleVideos: { url: string; order: number }[];
  } | null;
  exports: { id: string; url: string | null; storagePath: string | null }[];
};

type AssetOptions = { scope: AssetScope; includeExports: boolean };

export function projectSequenceAssets(
  source: SequenceAssetSource,
  options: AssetOptions
): SequenceAsset[] {
  const assets: SequenceAsset[] = [];
  const history = options.scope === 'history';
  const sceneNumber = new Map(
    [...source.scenes]
      .sort((a, b) => a.orderIndex - b.orderIndex || a.id.localeCompare(b.id))
      .map((scene) => [scene.id, scene.orderIndex + 1])
  );
  const shotsByScene = new Map<string, SequenceAssetSource['shots']>();
  for (const shot of source.shots) {
    const list = shotsByScene.get(shot.sceneId) ?? [];
    list.push(shot);
    shotsByScene.set(shot.sceneId, list);
  }
  const shotPlace = new Map<string, { scene: number; shot: number }>();
  for (const [sceneId, shots] of shotsByScene) {
    const scene = sceneNumber.get(sceneId);
    if (scene === undefined) continue;
    const ordered = [...shots].sort(
      (a, b) =>
        (a.shotNumber ?? 0) - (b.shotNumber ?? 0) || a.id.localeCompare(b.id)
    );
    ordered.forEach((shot, index) => {
      shotPlace.set(shot.id, { scene, shot: shot.shotNumber ?? index + 1 });
    });
  }
  const framesByShot = new Map<string, SequenceAssetSource['frames']>();
  for (const frame of source.frames) {
    const list = framesByShot.get(frame.shotId) ?? [];
    list.push(frame);
    framesByShot.set(frame.shotId, list);
  }

  pushText(assets, scriptAsset(source));
  for (const element of source.elements)
    pushFile(assets, elementAsset(element));
  pushStills(assets, source, framesByShot, shotPlace, history);
  pushVideos(assets, source, history);
  pushPrompts(assets, source, shotPlace);
  pushDialogue(assets, source, history);
  pushMusic(assets, source, history);
  pushCast(assets, source, history);
  pushLocations(assets, source, history);
  pushStyle(assets, source.style);
  if (options.includeExports) pushExports(assets, source.exports, history);

  assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return assets;
}

function scriptAsset(source: SequenceAssetSource): SequenceAsset | null {
  const text = source.sequence.script?.trim() ?? '';
  if (text === '') return null;
  return textAsset({
    kind: 'script',
    role: 'script',
    group: 'Script',
    label: 'Script',
    relativePath: 'script.txt',
    text: `${text}\n`,
    versionId: textVersionId(text),
    owners: [source.sequence.id],
    selected: true,
  });
}

function elementAsset(
  element: SequenceAssetSource['elements'][number]
): SequenceAsset | null {
  const url = assetDownloadUrl({
    url: element.imageUrl,
    storagePath: element.imagePath,
  });
  if (!url) return null;
  const ext = fileExtension(element.imageUrl, element.imagePath, 'bin');
  const token = /^[A-Z0-9_]+$/.test(element.token)
    ? element.token
    : `element-${element.id}`;
  return fileAsset({
    kind: 'element',
    role: 'file',
    group: 'Elements',
    label: element.token,
    relativePath: `elements/${token}.${ext}`,
    url,
    versionId: element.id,
    owners: [element.id],
    selected: true,
    discarded: false,
    shared: false,
    ext,
  });
}

function pushStills(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  framesByShot: Map<string, SequenceAssetSource['frames']>,
  shotPlace: Map<string, { scene: number; shot: number }>,
  history: boolean
) {
  const byFrame = new Map<string, SequenceAssetSource['stills']>();
  for (const still of source.stills) {
    if (still.kind === 'preview') continue;
    const list = byFrame.get(still.frameId) ?? [];
    list.push(still);
    byFrame.set(still.frameId, list);
  }
  for (const [shotId, frames] of framesByShot) {
    const place = shotPlace.get(shotId);
    if (!place) continue;
    const many = frames.length > 1;
    for (const frame of frames) {
      const versions = byFrame.get(frame.id) ?? [];
      const pointer = versions.find(
        (version) => version.id === frame.selectedImageVersionId
      );
      const folder = many
        ? `scenes/${place.scene}/shots/${place.shot}/frames/${frame.id}`
        : `scenes/${place.scene}/shots/${place.shot}`;
      const group = `Scene ${place.scene}`;
      const label = `Scene ${place.scene} shot ${place.shot} still`;
      emitVersioned(assets, {
        versions,
        pointerId: frame.selectedImageVersionId,
        history,
        folder,
        stem: 'still',
        fallbackExt: 'png',
        kind: 'still',
        role: 'still',
        group,
        label,
        owners: [shotId],
        shared: false,
        extra: pointer,
      });
    }
  }
}

function pushVideos(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  history: boolean
) {
  const shotsBySegment = new Map<string, string[]>();
  for (const shot of source.shots) {
    if (!shot.renderSegmentId) continue;
    const list = shotsBySegment.get(shot.renderSegmentId) ?? [];
    list.push(shot.id);
    shotsBySegment.set(shot.renderSegmentId, list);
  }
  const bySegment = new Map<string, SequenceAssetSource['videos']>();
  for (const video of source.videos) {
    const list = bySegment.get(video.renderSegmentId) ?? [];
    list.push(video);
    bySegment.set(video.renderSegmentId, list);
  }
  for (const segment of source.segments) {
    const versions = bySegment.get(segment.id) ?? [];
    for (const version of versions) {
      if (!downloadable(version)) continue;
      const chosen = version.id === segment.selectedVideoVersionId;
      const discarded = version.discardedAt != null;
      if (!history && (!chosen || discarded)) continue;
      const url = assetDownloadUrl(version);
      if (!url) continue;
      const ext = fileExtension(version.url, version.storagePath, 'mp4');
      pushFile(
        assets,
        fileAsset({
          kind: 'video',
          role: 'clip',
          group: 'Video',
          label: 'Segment clip',
          relativePath: `segments/${version.id}.${ext}`,
          url,
          versionId: version.id,
          owners: shotsBySegment.get(segment.id) ?? [],
          selected: chosen && !discarded,
          discarded,
          shared: false,
          ext,
        })
      );
    }
  }
}

function pushPrompts(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  shotPlace: Map<string, { scene: number; shot: number }>
) {
  for (const prompt of source.prompts) {
    const place = shotPlace.get(prompt.shotId);
    if (!place) continue;
    const text = prompt.text.trim();
    if (text === '') continue;
    pushText(
      assets,
      textAsset({
        kind: 'prompt',
        role: 'prompt',
        group: `Scene ${place.scene}`,
        label: `Scene ${place.scene} shot ${place.shot} prompt`,
        relativePath: `scenes/${place.scene}/shots/${place.shot}/prompt.txt`,
        text: `${text}\n`,
        versionId: prompt.id,
        owners: [prompt.shotId],
        selected: true,
      })
    );
  }
}

function pushDialogue(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  history: boolean
) {
  const sectionsBySpeech = new Map<string, SequenceAssetSource['sections']>();
  for (const section of source.sections) {
    const list = sectionsBySpeech.get(section.speechId) ?? [];
    list.push(section);
    sectionsBySpeech.set(section.speechId, list);
  }
  for (const speech of source.speeches) {
    const sections = sectionsBySpeech.get(speech.id) ?? [];
    const selected = sections.some((section) => section.selected);
    if (!history && !selected) continue;
    const url = assetDownloadUrl({
      url: speech.url,
      storagePath: speech.storageKey,
    });
    if (url) {
      const ext = fileExtension(speech.url, speech.storageKey, 'wav');
      pushFile(
        assets,
        fileAsset({
          kind: 'dialogue',
          role: 'speech',
          group: 'Dialogue',
          label: 'Dialogue',
          relativePath: `dialogue/${speech.id}.${ext}`,
          url,
          versionId: speech.id,
          owners: [...new Set(sections.map((section) => section.shotId))],
          selected,
          discarded: false,
          shared: false,
          ext,
        })
      );
    }
    const cuts = (history ? sections : sections.filter((s) => s.selected)).map(
      (section) => ({
        shotId: section.shotId,
        startSeconds: section.fromSeconds,
        endSeconds: section.toSeconds,
      })
    );
    if (cuts.length === 0) continue;
    const text = `${JSON.stringify(cuts, null, 2)}\n`;
    pushText(
      assets,
      textAsset({
        kind: 'dialogue_cuts',
        role: 'cuts',
        group: 'Dialogue',
        label: 'Dialogue cuts',
        relativePath: `dialogue/${speech.id}.cuts.json`,
        text,
        versionId: textVersionId(text),
        owners: [...new Set(cuts.map((cut) => cut.shotId))],
        selected,
      })
    );
  }
}

function pushMusic(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  history: boolean
) {
  for (const track of source.music) {
    if (!downloadable(track)) continue;
    const chosen = track.id === source.selectedMusicVariantId;
    const discarded = track.discardedAt != null;
    if (!history && (!chosen || discarded)) continue;
    const url = assetDownloadUrl(track);
    if (!url) continue;
    const ext = fileExtension(track.url, track.storagePath, 'mp3');
    pushFile(
      assets,
      fileAsset({
        kind: 'music',
        role: 'track',
        group: 'Music',
        label: 'Music',
        relativePath: `music/${track.id}.${ext}`,
        url,
        versionId: track.id,
        owners: [],
        selected: chosen && !discarded,
        discarded,
        shared: false,
        ext,
      })
    );
  }
}

function pushCast(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  history: boolean
) {
  const sheetsByCharacter = new Map<string, SequenceAssetSource['sheets']>();
  for (const sheet of source.sheets) {
    const list = sheetsByCharacter.get(sheet.characterId) ?? [];
    list.push(sheet);
    sheetsByCharacter.set(sheet.characterId, list);
  }
  for (const character of source.characters) {
    const sheets = sheetsByCharacter.get(character.id) ?? [];
    for (const look of character.looks) {
      if (!history && look.deleted) continue;
      const lookId = look.id;
      const versions = sheets.filter(
        (sheet) => (sheet.lookId ?? character.id) === lookId
      );
      emitVersioned(assets, {
        versions,
        // A default look's pointer stays null on purpose. The live sheet is
        // the row the backfill stored under the character's id.
        pointerId:
          look.selectedSheetVersionId ?? (look.isDefault ? character.id : null),
        history,
        folder: `cast/${character.id}/looks/${lookId}`,
        stem: 'sheet',
        fallbackExt: 'png',
        kind: 'character_sheet',
        role: 'sheet',
        group: 'Cast',
        label: `${character.name} ${look.name} sheet`,
        owners: [character.id],
        shared: true,
        portraitKind: 'character_portrait',
      });
      if (
        !history &&
        look.selectedSheetVersionId == null &&
        versions.length === 0
      ) {
        pushLookFallback(assets, character, look);
      }
    }
    for (const take of source.voiceTakes) {
      if (take.characterId !== character.id) continue;
      if (take.status !== 'completed') continue;
      if (!history && (!take.selected || take.released)) continue;
      take.previews.forEach((preview, index) => {
        const url = assetDownloadUrl({
          url: preview.url,
          storagePath: preview.path,
        });
        if (!url) return;
        const takeNumber = preview.takeNumber ?? index + 1;
        const ext = fileExtension(preview.url, preview.path, 'mp3');
        pushFile(
          assets,
          fileAsset({
            kind: 'voice',
            role: 'take',
            group: 'Cast',
            label: `${character.name} voice take ${takeNumber}`,
            relativePath: `cast/${character.id}/voices/${take.id}-${takeNumber}.${ext}`,
            url,
            versionId: `${take.id}:${takeNumber}`,
            owners: [character.id],
            selected: take.selected && !take.released,
            discarded: take.released,
            shared: true,
            ext,
          })
        );
      });
    }
  }
}

function pushLookFallback(
  assets: SequenceAsset[],
  character: SequenceAssetSource['characters'][number],
  look: SequenceAssetSource['characters'][number]['looks'][number]
) {
  const url = assetDownloadUrl({
    url: look.sheetImageUrl,
    storagePath: look.sheetImagePath,
  });
  if (!url) return;
  const ext = fileExtension(look.sheetImageUrl, look.sheetImagePath, 'png');
  pushFile(
    assets,
    fileAsset({
      kind: 'character_sheet',
      role: 'sheet',
      group: 'Cast',
      label: `${character.name} ${look.name} sheet`,
      relativePath: `cast/${character.id}/looks/${look.id}/sheet.${ext}`,
      url,
      versionId: look.id,
      owners: [character.id],
      selected: true,
      discarded: false,
      shared: true,
      ext,
    })
  );
  pushPortrait(assets, {
    kind: 'character_portrait',
    url: look.sheetPortraitUrl,
    storagePath: null,
    folder: `cast/${character.id}/looks/${look.id}`,
    stem: 'portrait',
    versionId: look.id,
    label: `${character.name} ${look.name} portrait`,
    owners: [character.id],
    selected: true,
    discarded: false,
    historyName: false,
  });
}

function pushLocations(
  assets: SequenceAsset[],
  source: SequenceAssetSource,
  history: boolean
) {
  const byLocation = new Map<string, SequenceAssetSource['locationSheets']>();
  for (const sheet of source.locationSheets) {
    const list = byLocation.get(sheet.locationId) ?? [];
    list.push(sheet);
    byLocation.set(sheet.locationId, list);
  }
  for (const location of source.locations) {
    const versions = byLocation.get(location.id) ?? [];
    emitVersioned(assets, {
      versions,
      // A null pointer is the row the backfill stored under the location's id.
      pointerId: location.selectedReferenceVersionId ?? location.id,
      history,
      folder: `locations/${location.id}`,
      stem: 'sheet',
      fallbackExt: 'png',
      kind: 'location_sheet',
      role: 'sheet',
      group: 'Locations',
      label: `${location.name} sheet`,
      owners: [location.id],
      shared: true,
      portraitKind: 'location_portrait',
    });
    if (
      !history &&
      location.selectedReferenceVersionId == null &&
      versions.length === 0
    ) {
      const url = assetDownloadUrl({
        url: location.referenceImageUrl,
        storagePath: location.referenceImagePath,
      });
      if (url) {
        const ext = fileExtension(
          location.referenceImageUrl,
          location.referenceImagePath,
          'png'
        );
        pushFile(
          assets,
          fileAsset({
            kind: 'location_sheet',
            role: 'sheet',
            group: 'Locations',
            label: `${location.name} sheet`,
            relativePath: `locations/${location.id}/sheet.${ext}`,
            url,
            versionId: location.id,
            owners: [location.id],
            selected: true,
            discarded: false,
            shared: true,
            ext,
          })
        );
      }
    }
    for (const photo of source.photos) {
      if (photo.locationId !== location.id) continue;
      const url = assetDownloadUrl({ url: photo.url, storagePath: photo.path });
      if (!url) continue;
      const ext = fileExtension(photo.url, photo.path, 'jpg');
      pushFile(
        assets,
        fileAsset({
          kind: 'location_photo',
          role: 'photo',
          group: 'Locations',
          label: `${location.name} photo`,
          relativePath: `locations/${location.id}/photos/${photo.id}.${ext}`,
          url,
          versionId: photo.id,
          owners: [location.id],
          selected: true,
          discarded: false,
          shared: true,
          ext,
        })
      );
    }
  }
}

function pushStyle(
  assets: SequenceAsset[],
  style: SequenceAssetSource['style']
) {
  if (!style) return;
  const preview = assetDownloadUrl({
    url: style.previewUrl,
    storagePath: null,
  });
  if (preview) {
    const ext = fileExtension(style.previewUrl, null, 'png');
    pushFile(
      assets,
      fileAsset({
        kind: 'style',
        role: 'preview',
        group: 'Style',
        label: 'Style preview',
        relativePath: `style/${style.id}/preview.${ext}`,
        url: preview,
        versionId: style.id,
        owners: [style.id],
        selected: true,
        discarded: false,
        shared: true,
        ext,
      })
    );
  }
  for (const sample of style.sampleVideos) {
    const url = assetDownloadUrl({ url: sample.url, storagePath: null });
    if (!url) continue;
    const ext = fileExtension(sample.url, null, 'mp4');
    pushFile(
      assets,
      fileAsset({
        kind: 'style',
        role: 'sample',
        group: 'Style',
        label: `Style sample ${sample.order}`,
        relativePath: `style/${style.id}/sample-${sample.order}.${ext}`,
        url,
        versionId: `${style.id}:${sample.order}`,
        owners: [style.id],
        selected: true,
        discarded: false,
        shared: true,
        ext,
      })
    );
  }
}

function pushExports(
  assets: SequenceAsset[],
  exports: SequenceAssetSource['exports'],
  history: boolean
) {
  exports.forEach((row, index) => {
    if (!history && index !== 0) return;
    const url = assetDownloadUrl(row);
    if (!url) return;
    const ext = fileExtension(row.url, row.storagePath, 'mp4');
    pushFile(
      assets,
      fileAsset({
        kind: 'export',
        role: 'render',
        group: 'Exports',
        label: 'Rendered cut',
        relativePath: `exports/${row.id}.${ext}`,
        url,
        versionId: row.id,
        owners: [],
        selected: index === 0,
        discarded: false,
        shared: false,
        ext,
      })
    );
  });
}

function emitVersioned(
  assets: SequenceAsset[],
  input: {
    versions: (StoredFile & { portraitUrl?: string | null })[];
    pointerId: string | null;
    history: boolean;
    folder: string;
    stem: string;
    fallbackExt: string;
    kind: SequenceAsset['kind'];
    role: string;
    group: string;
    label: string;
    owners: string[];
    shared: boolean;
    portraitKind?: 'character_portrait' | 'location_portrait';
    extra?: StoredFile | undefined;
  }
) {
  const versions =
    input.extra &&
    !input.versions.some((version) => version.id === input.extra?.id)
      ? [...input.versions, input.extra]
      : input.versions;
  for (const version of versions) {
    if (!downloadable(version)) continue;
    const discarded = version.discardedAt != null;
    const chosen = version.id === input.pointerId && !discarded;
    if (!input.history && !chosen) continue;
    const url = assetDownloadUrl(version);
    if (!url) continue;
    const ext = fileExtension(
      version.url,
      version.storagePath,
      input.fallbackExt
    );
    if (chosen) {
      pushFile(
        assets,
        fileAsset({
          ...input,
          relativePath: `${input.folder}/${input.stem}.${ext}`,
          url,
          versionId: version.id,
          selected: true,
          discarded: false,
          ext,
        })
      );
    }
    if (input.history) {
      pushFile(
        assets,
        fileAsset({
          ...input,
          relativePath: `${input.folder}/${input.stem}.${version.id}.${ext}`,
          url,
          versionId: version.id,
          selected: chosen,
          discarded,
          ext,
        })
      );
    }
    if (!input.portraitKind) continue;
    const portraitUrl =
      'portraitUrl' in version && typeof version.portraitUrl === 'string'
        ? version.portraitUrl
        : null;
    pushPortrait(assets, {
      kind: input.portraitKind,
      url: portraitUrl,
      storagePath: null,
      folder: input.folder,
      stem: 'portrait',
      versionId: version.id,
      label: input.label.replace(/sheet$/, 'portrait'),
      owners: input.owners,
      selected: chosen,
      discarded,
      historyName: input.history,
      stable: chosen,
    });
  }
}

function pushPortrait(
  assets: SequenceAsset[],
  input: {
    kind: 'character_portrait' | 'location_portrait';
    url: string | null;
    storagePath: string | null;
    folder: string;
    stem: string;
    versionId: string;
    label: string;
    owners: string[];
    selected: boolean;
    discarded: boolean;
    historyName: boolean;
    stable?: boolean;
  }
) {
  const url = assetDownloadUrl({
    url: input.url,
    storagePath: input.storagePath,
  });
  if (!url) return;
  const ext = fileExtension(input.url, input.storagePath, 'png');
  const group = input.kind === 'location_portrait' ? 'Locations' : 'Cast';
  const row = (relativePath: string, discarded: boolean) =>
    fileAsset({
      kind: input.kind,
      role: 'portrait',
      group,
      label: input.label,
      relativePath,
      url,
      versionId: input.versionId,
      owners: input.owners,
      selected: input.selected,
      discarded,
      shared: true,
      ext,
    });
  if (input.stable ?? !input.historyName) {
    pushFile(assets, row(`${input.folder}/${input.stem}.${ext}`, false));
  }
  if (!input.historyName) return;
  pushFile(
    assets,
    row(
      `${input.folder}/${input.stem}.${input.versionId}.${ext}`,
      input.discarded
    )
  );
}

function downloadable(file: StoredFile): boolean {
  return file.status === 'completed' && assetDownloadUrl(file) != null;
}

function fileAsset(input: {
  kind: SequenceAsset['kind'];
  role: string;
  group: string;
  label: string;
  relativePath: string;
  url: string;
  versionId: string;
  owners: string[];
  selected: boolean;
  discarded: boolean;
  shared: boolean;
  ext: string;
}): SequenceAsset {
  return {
    id: input.relativePath,
    kind: input.kind,
    role: input.role,
    group: input.group,
    label: input.label,
    selected: input.selected,
    discarded: input.discarded,
    shared: input.shared,
    relativePath: input.relativePath,
    url: input.url,
    text: null,
    contentType: contentTypeForExtension(input.ext),
    versionId: input.versionId,
    owners: input.owners,
  };
}

function textAsset(input: {
  kind: SequenceAsset['kind'];
  role: string;
  group: string;
  label: string;
  relativePath: string;
  text: string;
  versionId: string;
  owners: string[];
  selected: boolean;
}): SequenceAsset {
  const ext = input.relativePath.endsWith('.json') ? 'json' : 'txt';
  return {
    id: input.relativePath,
    kind: input.kind,
    role: input.role,
    group: input.group,
    label: input.label,
    selected: input.selected,
    discarded: false,
    shared: false,
    relativePath: input.relativePath,
    url: null,
    text: input.text,
    contentType: contentTypeForExtension(ext),
    versionId: input.versionId,
    owners: input.owners,
  };
}

function pushFile(assets: SequenceAsset[], asset: SequenceAsset | null) {
  if (!asset || !safeRelativePath(asset.relativePath)) return;
  assets.push(asset);
}

function pushText(assets: SequenceAsset[], asset: SequenceAsset | null) {
  pushFile(assets, asset);
}

function safeRelativePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\')) return false;
  return path
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..');
}
