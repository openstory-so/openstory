# Sequence asset download (#2209)

The manifest is the product. The asset page, the Chromium folder save, and `npx @openstory/cli@latest pull` all write that one list. Nothing in the Worker builds a zip, and nothing hands out R2 credentials.

## Where it lives

- `GET /api/v1/sequences/{id}/assets` returns the list. `scope` is `selected` (default) or `history`. `exports=true` adds rendered MP4s. Any other `scope` is read as `selected`.
- The page is `/sequences/$id/assets`. Download → All files opens it. The Canvas/Script bar does not. The page shows `npx @openstory/cli@latest pull` for the toggles on screen, in the same terminal block as Skills & MCP (`/connect`). `--origin` is added when the page is not `https://openstory.so`.
- Download folder calls `showDirectoryPicker` with `startIn: 'videos'` and id `openstory-sequence-assets`, then writes a child folder named for the sequence. Chrome blocks the home folder, Desktop, Documents, and Downloads themselves. Movies is not on that list.
- MCP tool `openstory.list_sequence_assets`. Same list. A long history can exceed the 256 KiB tool cap, and that call fails. v1 does not page it.
- `npx @openstory/cli@latest pull <sequenceId>` (`@openstory/cli`, bin `openstory`; `stitch pull` passes through to it for one minor version). Shared files are cached in `~/.openstory/assets` (`openstory sync` uses `<data folder>/.openstory/cache`, on the same volume, so hard links hold). Flags: `--history`, `--exports`, `--origin`, `--dir` (default `./<sequenceId>`).

## What a row is

A row is downloadable when its status is `completed` and the bytes are in R2. The url is origin-relative `/r2/…?download`. Text rows (script, prompt, dialogue cuts) carry `text` and a null url. Preview frames and provider-CDN urls stay out. In-flight and failed rows stay out.

`selected` is the current pointers. A discarded row stays out even when a pointer still names it. `history` adds every completed stored still, clip, sheet, voice take, speech, and music row, including discarded ones (`discarded: true`). It does not add older scripts or prompts: both scopes use the current script and each shot's selected motion prompt. History is opt-in.

Cast, location, and style files are `shared: true`. They belong to the organization. The sequence folder still holds a copy. The CLI keeps one organization cache at `~/.openstory/assets/` and hard-links it into the folder (a copy when the link crosses devices). The cache file is named from the stored `/r2` path, so a sheet and its portrait never share bytes. A text row with no url is named from its `versionId` and extension.

## Folder

Paths are readable (#2222): ordinals plus titles, and slugs. Versions keep their ids. See `docs/architecture/local-library.md`.

- `script.txt` when the script is non-empty.
- `elements/<TOKEN>.<ext>` when the token is `[A-Z0-9_]+`, otherwise `elements/element-<id>.<ext>`.
- A scene folder is `scenes/<nn>-<title-slug>` (`scenes/03-the-chase`), `nn` being `orderIndex + 1`, two digits; a scene with no title is `scenes/<nn>`. A shot folder is `shots/<mm>-<words>`, the words from its selected spec's shot size and action (at most six), or `shots/<mm>` with no spec. Shot number falls back to position.
- One frame on a shot: `<shot folder>/still.<ext>`. Two or more frames: `<shot folder>/frames/<frameId>/still.<ext>`, even when each frame has one still. History also writes `still.<versionId>.<ext>`.
- Video: the selected clip is `segments/<nn>-<shot folder name>.<ext>`, named by the segment's first shot (`segments/03-02-wide-marlowe-runs.mp4`), or the segment id when it has no shot. History adds `segments/<name>.<videoVersionId>.<ext>`. The group label is Video.
- Selected motion prompt: `<shot folder>/prompt.txt`.
- Dialogue is the whole speech under the scene of its first shot, `dialogue/<scene folder name>/<speechId>.<ext>`, plus `<speechId>.cuts.json`. Do not pre-cut wavs.
- Music: the selected track is `music/music.<ext>`; history adds `music/music.<id>.<ext>`.
- Character sheet: `cast/<character-slug>/looks/<look-name-slug>/sheet.<ext>` (a repeated look name takes `-2`). Portrait: `portrait.<ext>`. Voice takes: `cast/<character-slug>/voices/<versionId>-<takeNumber>.<ext>`.
- Location sheet and portrait live under `locations/<location-slug>/`. Photos: `locations/<location-slug>/photos/<photoId>.<ext>`.
- Style preview and samples under `style/<style-slug>/`, stored `/r2` urls only.
- Exports, only when asked: `exports/<id>.<ext>`. Selected is the newest ready export.

A second sync reads `manifest.json` and skips a path whose `versionId` matches and whose file is still there. A path the previous `manifest.json` listed and this one does not is removed, then any folder that leaves empty; nothing else in the folder is touched, and a path a symlink leads outside the folder is skipped. So a scene reorder or a rename moves files instead of leaving copies. The browser folder save does not remove anything.

A default look's null sheet pointer is the character id, and a location's null sheet pointer is the location id: those are the rows the backfill stored. Sheet fallback bytes are used only when that stored pointer is null and there are no version rows. A pointer that names a missing row contributes nothing.

Studio `generated_assets` and the BytePlus pool stay out. A container zip is not this feature.
