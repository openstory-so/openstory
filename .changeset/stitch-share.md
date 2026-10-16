---
'@openstory/stitch': minor
---

`stitch bundle <dir> …` writes a self-contained folder: the player page, `cut.json`, and every file under `media/` (a URL is downloaded). The page reads its cut and media relative to itself, so the folder plays from any static host and sub-path.

`stitch share …` uploads that bundle to OpenStory and prints a link anyone can watch. The first share signs in with a device code and keeps the key in `~/.openstory/stitch.json`; `--origin` picks the server.
