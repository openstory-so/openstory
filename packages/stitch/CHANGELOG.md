# @openstory/stitch

## 0.2.0

### Minor Changes

- 75e184b: Rename the package from @openstory/stitch-player. `npx @openstory/stitch` plays local stills and videos in the browser, and `stitch skill` installs the /stitch command plus the stitch-player contract into `.agents/skills` and `.claude/skills`. The preview frame is the canvas box of the clips, so a portrait cut fills the window as portrait. `--subs` takes one `.srt` or `.vtt` for the whole cut. The page shows a loading line, warns about silent or missing media and mixed resolutions, and has icon buttons for music and Download. The package README is also in Chinese, French, and Spanish.

### Patch Changes

- 97b8c0a: Hold a still for the longer of its shot and its dialogue, so a short recording no longer rushes the picture.
- 44a113a: The README opens its Skill section with `npx @openstory/stitch skill`, which installs `stitch` and `stitch-player` into `.agents/skills` and `.claude/skills`, and `--global` for the home directory.
