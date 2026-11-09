# @openstory/cli

The OpenStory command line: sign in, download a sequence's files, mirror your library, and share a cut. Nothing to install:

```sh
npx @openstory/cli@latest <command>
```

Keep `@latest`: npx and bunx can otherwise run a stale cached copy. The bin is `openstory`. The unscoped `openstory` package on npm is an unrelated project.

## Commands

```sh
npx @openstory/cli@latest login
npx @openstory/cli@latest pull 01JSEQUENCE --dir ./room
npx @openstory/cli@latest sync
npx @openstory/cli@latest share --music score.mp3 shot.mp4 board.png --audio line.wav
```

- `login` signs in with a device code: it prints a short code and opens the approval page in your browser. `pull` and `share` do the same on first use.
- `pull <sequenceId>` downloads the current cut into `./<sequenceId>` (or `--dir`). A later run skips a file that is already there at the same version. `--history` adds every completed version, including discarded ones. `--exports` adds rendered MP4s.
- `pull` names folders by order and title: `scenes/03-the-chase/shots/02-wide-marlowe-runs/still.png`, `cast/marlowe/looks/default/sheet.png`. A file the previous run wrote and the sequence no longer lists is removed; nothing else in the folder is touched.
- `sync` mirrors every sequence of your organization into `~/openstory/<organization>/<sequence>/` (or `--dir`) and keeps it current until you stop it. Your sign-up organization is `personal/`. A renamed sequence renames its folder; an archived one is left alone. The folder is output only: OpenStory never reads it back. `--once` stops after the first pass. One folder mirrors one server.
- `share …` takes the cut options of [`@openstory/stitch`](https://github.com/openstory-so/openstory/tree/main/packages/stitch#readme), uploads every file to your organization and prints `https://openstory.so/stitch/<id>`, a page anyone with the link can watch. Every still is checked for a real person; one who is needs `--portrait-rights <basis>`, the basis for using their likeness (a release reference, `self`, a contract id).

Every command takes `--origin <url>` to talk to another OpenStory server.

## Files

- `~/.openstory/credentials.json` holds one API key per server. A `~/.openstory/stitch.json` left by stitch 0.4 is renamed to it once.
- `~/.openstory/assets/` holds cast, location and style files once; `pull` links them into each folder. `sync` keeps its own in `<dir>/.openstory/cache`, beside `<dir>/.openstory/sync.json`, which maps each organization and sequence to its folder.
- `~/.openstory/cli-update.json` remembers the last check for a newer version. The CLI asks npm at most once a day, prints a one-line hint on stderr, and never updates itself. No check runs under `CI` or without a terminal.

If OpenStory answers that the CLI is too old, run it again with `npx @openstory/cli@latest`.

## License

MIT
