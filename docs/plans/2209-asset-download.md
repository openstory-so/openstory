# Sequence asset download (#2209)

Decision record for taking a sequence's media off OpenStory. Slices 1 to 4 shipped in this change: the manifest, the asset page, Chromium folder save, and `npx` / `bunx @openstory/stitch pull`. The rules that bite live in `docs/architecture/asset-download.md`. Where this note disagrees with that doc, the architecture doc is the behavior that shipped. A container zip is still not built. A worker zip and raw R2 credentials stay ruled out.

## What exists today

A person can already take three things, each a single file of the current cut:

- The selected video of one shot (`getShotDownloadUrlFn` in `src/shots/shots.fn.ts`). The file is the segment `render_segments.selectedVideoVersionId` points at. `shots.videoPath` is gone.
- One studio output, via `/r2/<key>?download`. `serveStoredMedia` streams that request with `content-disposition: attachment` instead of redirecting to the CDN, where `<a download>` is ignored.
- One rendered MP4 of the current cut (`POST /api/v1/sequences/$id/exports` → `SequenceExportWorkflow` → the video-export container). Playback does not use it. Plain `bun dev` has no renderer.

"Share stitch link" publishes the cut the theatre plays. It is a watch page, not an archive.

Nothing lists every version, nothing walks characters and locations, and nothing resumes a partial copy.

## What "the lot" is

Versions are append-only rows. Selection is a pointer. A download names rows that have bytes in R2 (`storagePath`, `path`, or `url` beginning `/r2/`). A preview frame with only a provider CDN url (#1091) stays out. In-flight and failed rows stay out. `discardedAt` rows stay out of the default list and appear when the caller asks for history.

| Kind                 | Rows                                       | Selection pointer                                | File                                                                                            |
| -------------------- | ------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Shot still           | `frame_variants`                           | `frames.selectedImageVersionId`                  | `storagePath`                                                                                   |
| Shot video           | `video_variants`                           | `render_segments.selectedVideoVersionId`         | `storagePath`. One file covers every shot in the segment.                                       |
| Character sheet      | `character_sheet_variants`                 | the look's `selectedSheetVersionId`              | `storagePath`, plus `portraitUrl` when it is stored                                             |
| Voice audition       | `character_voice_versions.previews`        | the character's saved voice                      | preview MP3 `path`. The saved voice id is a provider slot, not a file.                          |
| Location sheet       | `location_sheet_variants`                  | `locations.selectedReferenceVersionId`           | `storagePath`                                                                                   |
| Location photo       | `location_reference_photos`                | the photo is the source                          | `path`                                                                                          |
| Element              | `sequence_elements`                        | the row, while `deletedAt` is null               | `imagePath` (image, clip, or audio)                                                             |
| Dialogue             | `dialogue_speeches`                        | the shot's selected `shot_dialogue_sections` row | `storageKey` of the whole speech. A shot's clip is a time range of that file, not its own file. |
| Music                | `sequence_music_variants`                  | the sequence's selected music version            | `storagePath`                                                                                   |
| Style sample         | `styles.previewUrl`, `styles.sampleVideos` | the sequence's style                             | stored urls only                                                                                |
| Rendered cut         | `sequence_exports`                         | the newest ready export                          | the MP4 in R2. Derived.                                                                         |
| Prompt, spec, script | version tables                             | the shot and scene pointers                      | text. No media bytes.                                                                           |

Characters, looks, and locations belong to the team (#2017, #1695). A sequence reaches them through cast and location links. The same sheet is the current sheet of every sequence that casts that character. Studio `generated_assets` and BytePlus pool entries are team or account files, not sequence files, and stay out of the first slice.

## Options

### 1. A manifest, then one download per file

`GET /api/v1/sequences/$id/assets` returns a JSON list. Each entry is `{ id, kind, role, selected, discarded, shared, relativePath, url, contentType, versionId, owners }`. `url` is the origin-relative `/r2/…?download` the app already serves. `relativePath` is the stable name a folder writer uses. `shared` is true for team cast and location files.

The same list is a server fn for the page and an MCP read (`list_sequence_assets`), so the assistant and a script see one shape. The public schema is generated with the rest of `/api/v1`.

Bytes stay in R2. The Worker returns a document, which fits the 128 MB isolate. A client that already has an entry's `versionId` skips it, so a second sync is small.

Two scopes. `selected` (the default) is the pointers: the still and video the cut plays, the sheets and photos of the cast and locations on the sequence, the elements, the speeches those shots' sections point at, the selected music, and the style samples. `history` adds every completed stored version, with `discarded: true` on soft-hidden rows. History is how "all versions" is spelled. It is opt-in because a re-rolled sequence is many times the size of the cut.

### 2. An asset page on the sequence

A route that renders that manifest, grouped by character, location, element, scene, and music. Each row shows the still or a label, whether it is the selected version, and a download link. A control switches `selected` and `history`.

This is the asset view. It adds no second inventory.

### 3. Save a folder from the browser

On Chromium, the page calls `showDirectoryPicker` and writes each `relativePath`, skipping a file whose stored `versionId` matches. Other browsers keep the per-row download. The tab has to stay open, and a multi-gigabyte history run is a bad fit for a tab. This covers "download the lot" for the selected cut.

The page writes text sidecars (`script`, shot spec, motion prompt, the speech's `{ shotId, startSeconds, endSeconds }` cuts) from fields on the manifest. The server does not pre-build those files.

### 4. A CLI pull

`npx` a small command that signs in with the device code (`/api/v1/device/code`, the stitch share sign-in), fetches the manifest, and writes the folder. Team files land once under a shared cache keyed by `versionId`. A later run skips matches. This is the sync. It resumes, it runs unattended, and it can take `history`.

The stitch CLI stays a player. This command is a sibling, or a later subcommand, and it does not render an MP4.

### 5. One zip built in the video-export container

The container already streams a large MP4 into R2 without holding it on the isolate. The same shape can stream a zip (stored, not deflated — the media is already compressed) into R2 and hand back one URL.

Worth having later as a single attachment for someone who asked for a zip. Weak as the sync: the archive is stale when the next version lands, it duplicates every byte into R2, and a failed download starts over. Build it only after the manifest exists, and only for `selected`.

### 6. A zip built inside the Worker

Out. A clip must not sit in Worker memory, and a sequence of versions is many clips. Streaming a zip through the isolate also pulls every byte off the CDN and back through the Worker.

### 7. Bucket credentials for rclone

Out. R2 keys are team-mixed in one bucket, and `/r2/$` is already a capability URL: knowing the key is the credential. A manifest behind sequence auth is the list. Handing out the bucket hands out every team.

## Recommendation

Ship 1 and 2 first, then 3, then 4. Leave 5 until someone asks for a single archive. Leave 6 and 7.

The manifest is the product. The page, the folder save, and the CLI are writers of that list. Starting with a zip would bake in a one-shot copy and a second, stale tree.

Default scope is `selected`. History is a switch on the page and a flag on the CLI, labelled as every completed version including discarded ones.

Folder layout, so a sync and a zip agree:

```
<sequence-id>/
  manifest.json
  script.txt
  elements/<token>.<ext>
  scenes/<sceneNumber>/shots/<shotNumber>/
    still.<ext>
    prompt.txt
  segments/<videoVersionId>.mp4
  dialogue/<speechId>.<ext>
  dialogue/<speechId>.cuts.json
  music/<musicVersionId>.<ext>
  cast/<characterId>/looks/<lookId>/sheet.<ext>
  cast/<characterId>/voices/<takeNumber>.mp3
  locations/<locationId>/sheet.<ext>
  locations/<locationId>/photos/<photoId>.<ext>
```

History inserts the version id before the extension (`still.<versionId>.<ext>`) and leaves the pointer's file at the stable name above. A segment file appears once. Shot folders do not each contain a copy. `manifest.json` maps each shot to its segment.

`shared` cast and location files use those same relative paths inside a sequence snapshot, so a folder stands alone. The CLI also keeps one team cache and hard-links or skips when the bytes are already there.

Rendered exports are a separate group, off by default. They are large and reproducible from the cut.

## First build

1. A pure `listSequenceAssets(scopedDb, sequenceId, scope)` covered by `createTestDb`. It reads through the scoped-db modules. It returns stored, completed rows only.
2. `GET /api/v1/sequences/$id/assets` and the MCP read, both calling that function. Sequence read auth. The OpenAPI component comes from the Zod schema.
3. The asset page, Suspense, the existing download href. No zip, no new R2 writes.

Folder save and the CLI are the next issues, against this manifest, so the path strings do not get invented twice.

## Risks

- History payloads can be large as JSON. Page the history scope by kind if one sequence exceeds a few thousand rows. The selected scope is one row per pointer and stays one response.
- `/r2/<key>` is readable by anyone who has the key. The manifest is the index, so it stays on the authenticated API. Do not attach it to a public stitch.
- Team sheets change under a sequence that already synced. The next sync sees a new `versionId` and adds the file. The old file remains in `history`.
- Dialogue is one wav for a stretch of shots. The cuts sidecar is the per-shot view. Pre-cutting wavs would be a container job and is not part of this.
