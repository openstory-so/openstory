# Sequence asset download (#2209)

The manifest is the product. The asset page, the Chromium folder save, and `npx @openstory/stitch pull` all write that one list. Nothing in the Worker builds a zip, and nothing hands out R2 credentials.

## Where it lives

- `GET /api/v1/sequences/{id}/assets` returns the list. `scope` is `selected` (default) or `history`. `exports=true` adds rendered MP4s. Any other `scope` is read as `selected`.
- The page is `/sequences/$id/assets`. Download → All files opens it. The Canvas/Script bar does not. The page shows `npx @openstory/stitch pull` for the toggles on screen, in the same terminal block as Skills & MCP (`/connect`). `--origin` is added when the page is not `https://openstory.so`.
- Download folder calls `showDirectoryPicker` with `startIn: 'videos'` and id `openstory-sequence-assets`, then writes a child folder named for the sequence. Chrome blocks the home folder, Desktop, Documents, and Downloads themselves. Movies is not on that list.
- MCP tool `openstory.list_sequence_assets`. Same list. A long history can exceed the 256 KiB tool cap, and that call fails. v1 does not page it.
- `npx @openstory/stitch pull <sequenceId>` and `bunx @openstory/stitch pull <sequenceId>`. Flags: `--history`, `--exports`, `--origin`, `--dir` (default `./<sequenceId>`).

## What a row is

A row is downloadable when its status is `completed` and the bytes are in R2. The url is origin-relative `/r2/…?download`. Text rows (script, prompt, dialogue cuts) carry `text` and a null url. Preview frames and provider-CDN urls stay out. In-flight and failed rows stay out.

`selected` is the current pointers. A discarded row stays out even when a pointer still names it. `history` adds every completed stored still, clip, sheet, voice take, speech, and music row, including discarded ones (`discarded: true`). It does not add older scripts or prompts: both scopes use the current script and each shot's selected motion prompt. History is opt-in.

Cast, location, and style files are `shared: true`. They belong to the team. The sequence folder still holds a copy. The CLI keeps one team cache at `~/.openstory/assets/` and hard-links it into the folder (a copy when the link crosses devices). The cache file is named from the stored `/r2` path, so a sheet and its portrait never share bytes. A text row with no url is named from its `versionId` and extension.

## Folder

- `script.txt` when the script is non-empty.
- `elements/<TOKEN>.<ext>` when the token is `[A-Z0-9_]+`, otherwise `elements/element-<id>.<ext>`.
- One frame on a shot: `scenes/<n>/shots/<m>/still.<ext>`. Two or more frames: `.../frames/<frameId>/still.<ext>`, even when each frame has one still. History also writes `still.<versionId>.<ext>`. Scene number is `orderIndex + 1`. Shot number falls back to position.
- Video is one file, `segments/<videoVersionId>.<ext>`. The group label is Video. Selected is the segment pointer.
- Selected motion prompt: `scenes/<n>/shots/<m>/prompt.txt`.
- Dialogue is the whole speech, `dialogue/<speechId>.<ext>`, plus `dialogue/<speechId>.cuts.json`. Do not pre-cut wavs.
- Music: `music/<id>.<ext>`.
- Character sheet: `cast/<characterId>/looks/<lookId>/sheet.<ext>`. Portrait: `portrait.<ext>`. Voice takes: `cast/<characterId>/voices/<versionId>-<takeNumber>.<ext>`.
- Location sheet and portrait live under `locations/<id>/`. Photos: `locations/<id>/photos/<photoId>.<ext>`.
- Style preview and samples under `style/<styleId>/`, stored `/r2` urls only.
- Exports, only when asked: `exports/<id>.<ext>`. Selected is the newest ready export.

A second sync reads `manifest.json` and skips a path whose `versionId` matches and whose file is still there. Reordering scenes writes the new paths and leaves the old files.

A default look's null sheet pointer is the character id, and a location's null sheet pointer is the location id: those are the rows the backfill stored. Sheet fallback bytes are used only when that stored pointer is null and there are no version rows. A pointer that names a missing row contributes nothing.

Studio `generated_assets` and the BytePlus pool stay out. A container zip is not this feature.
