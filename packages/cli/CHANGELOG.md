# @openstory/cli

## 0.1.2

### Patch Changes

- bf11c4c: `openstory` sends at most 10 API-key requests, then waits more than a second, and retries when the server answers that the key is rate limited.

## 0.1.1

### Patch Changes

- 189c0b3: Depend on `@openstory/stitch` with a plain version range. 0.1.0 shipped `workspace:^`, which npm refuses to install.

## 0.1.0

### Minor Changes

- 02ba7c7: First release of `@openstory/cli` (bin `openstory`): `login`, `pull` and `share`, moved out of `@openstory/stitch`. Run it with `npx @openstory/cli@latest <command>`. Keys move from `~/.openstory/stitch.json` to `~/.openstory/credentials.json` on first run. Every request carries the CLI version (`X-OpenStory-CLI`), and a 426 from the server says to update. A newer version is noted on stderr at most once a day.

  `openstory sync` mirrors an organization's sequences into `~/openstory/<organization>/<sequence>/` and keeps it current.

  `pull` output changed: folders are named by order and title or slug (`scenes/03-the-chase/shots/02-wide-marlowe-runs/still.png`, `cast/marlowe/…`) instead of numbers and ids, and a file the previous run wrote that the sequence no longer lists is removed. A folder pulled by stitch 0.4 is rewritten under the new names on the next pull, and the old files are removed.

### Patch Changes

- Updated dependencies [02ba7c7]
  - @openstory/stitch@0.5.0
