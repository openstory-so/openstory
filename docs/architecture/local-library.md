# Local library (#2222)

Local state used to live in `.wrangler/state` inside the repo, where `git clean -fdx` or a re-clone wiped it, and nothing outside the app was browsable. Now a main checkout keeps its state in a data folder, `openstory sync` mirrors the library into readable folders beside it, and the account commands live in `@openstory/cli`.

## Two folders

- `~/openstory` is the **data folder**: the library. `~/openstory/.openstory/state` holds D1, R2 and Durable Object state; `~/openstory/<organization>/<sequence>/` is the mirror.
- `~/.openstory` is the **per-machine folder**: logins (`credentials.json`), dev tunnels, the CLI's update check, `pull`'s shared-file cache. It does not move.

## Where state lives

One resolver, `scripts/state-dir.ts`. `vite.config.ts` (`persistState`) and `scripts/local-platform-proxy.ts` (`getPlatformProxy`'s `persist`) read it, and so do Drizzle Studio and `db-worktree`. Nothing else picks a persist path: `scripts/state-dir.test.ts` pins the call sites, so a new script cannot migrate the wrong database. The vite plugin appends `v3` to its path and `getPlatformProxy` does not; `vitePersistPath` and `proxyPersistPath` hand each the shape it expects.

| Situation                                                  | State                               |
| ---------------------------------------------------------- | ----------------------------------- |
| `CLOUDFLARE_ENV=test`, `CI`, or a git worktree             | `<repo>/.wrangler/state`, as before |
| `OPENSTORY_DATA_DIR` set                                   | `<dir>/.openstory/state`            |
| main checkout with `~/openstory/.openstory/openstory.json` | `~/openstory/.openstory/state`      |
| main checkout not set up yet                               | `<repo>/.wrangler/state`            |

- **Worktrees ignore `OPENSTORY_DATA_DIR`.** A copied `.env.local` must never run an unmerged branch's migrations against the library. Fork it with `bun db:fork:local` instead.
- **Set-up happens in `bun dev`, once.** On a main checkout with a terminal, `bun dev` writes the marker `~/openstory/.openstory/openstory.json`, then moves an existing `.wrangler/state` into the data folder. Without a terminal nothing is created, so CI and agents never make one by accident. Once the marker exists, every script resolves to it with or without a terminal.
- **The marker is required.** `OPENSTORY_DATA_DIR` set and its marker missing (an unplugged drive) fails the boot by name. State never starts empty silently.
- **No merging.** State in both `.wrangler/state` and the data folder stops the boot and names both paths.
- **Lock.** The dev server writes its pid to `<dir>/.openstory/.lock` and removes it on exit. `bun dev` refuses to start while another live process holds it; a dead holder's lock is taken over.
- The bindings banner prints the full state path on every boot (`DATA state → …`).
- `bun setup` can choose another folder (written to `.env.local` as `OPENSTORY_DATA_DIR`) and warns on iCloud Desktop & Documents, `~/Library/Mobile Documents`, Dropbox, OneDrive and `~/Library/CloudStorage`: a sync client can corrupt a live SQLite file.
- `bun db:fork:local` clones the main checkout's state into a worktree with `cp -c` (an APFS clone; a plain copy elsewhere). `bun db:promote:local` refuses while the main checkout uses a data folder.

## Slugs

`sequences`, `characters`, `locations` (SQL table `sequence_locations`) and `styles` carry a `slug`, unique per organization (`idx_<table>_organization_slug`). It is set from the title or name, recomputed on rename (kept when the new name gives the same base), and takes `-2`, `-3` on collision (`freeSlug` in `src/platform/server/db/slug.ts`, `slugify` in `src/platform/slug.ts`). Slugs are lowercase, so one never passes `isValidId` and a slug-or-ULID parameter is never ambiguous.

- ULIDs stay the only identity. No foreign key, stored URL or R2 key uses a slug. Scenes and shots store none.
- `/api/v1/sequences/{id}`, its `assets` and `exports`, and `/api/v1/styles/{id}` take a slug or a ULID (`resolveId` on each scoped-db module). Every MCP tool does too: `resolveSlugs` in `src/platform/server/mcp/tool-context.ts` turns a slug in a top-level `sequenceId`, `characterId`, `locationId` or `styleId` into its ULID before the tool runs (an unknown slug is not found). HAL links and tool results keep the ULID.
- The sequence, character and location pages redirect a slug to the same URL with the ULID (`src/platform/ui/slug-redirect.ts`).
- A slug resolves only inside the caller's organization; public style templates still resolve by id.
- The backfill (`20261108062356_backfill_slugs`) is SQL, which cannot strip accents: it writes `Café Noir` as `caf-noir` where a new write gives `cafe-noir`. A rename fixes an old row.
- The schema column has a DDL default of `''` (so the column could be added) and a `$defaultFn` (`testOnlySlug`) that gives a test row a lowercase ULID and throws outside Vitest, so an app insert that forgets the slug fails instead of getting a random one. Every app create path sets the real one with `freeSlug`.
- The default organization's slug is `org-<user id, lowercased>`. It used the first 8 characters of the user id, which are only a timestamp, so two sign-ups in the same ~256 ms collided.

## Readable paths

The manifest (`docs/architecture/asset-download.md`) names folders by ordinal and title and by slug: `scenes/03-the-chase/shots/02-wide-marlowe-runs/still.png`, `cast/marlowe/looks/default/sheet.png`, `locations/the-docks/sheet.png`, `style/noir/preview.png`. A shot's words are its spec's shot size and action, at most six words. Versions keep their ids: the chosen one is the plain file, `history` adds every other completed version as `<name>.<versionId>.<ext>`.

`pull` and `sync` remove a file the previous `manifest.json` listed and the new one does not, then any folder that leaves empty. Nothing else in the folder is touched, and a path a symlink leads outside the folder is skipped. So a scene reorder or a rename moves files rather than leaving copies.

## `@openstory/cli`

Rule: **stitch never talks to openstory.so.** `@openstory/stitch` keeps the player library, `stitch <files>`, `stitch bundle` and `stitch skill`. `@openstory/cli` (bin `openstory`) has `login`, `pull`, `share` and `sync`. For one minor version `stitch pull` and `stitch share` print a moved note and run `npx @openstory/cli@latest` (on Windows they print the command instead, because npx.cmd only starts through cmd.exe, which would parse the arguments).

- Docs say `npx @openstory/cli@latest …`. The unscoped `openstory` npm package is an unrelated project.
- Every request carries `X-OpenStory-CLI: <version>`. `cliVersionMiddleware` (first in `src/start.ts`) answers 426 below `MIN_CLI_VERSION` (`src/platform/server/api-v1/cli-version.ts`). A request without the header passes.
- The CLI checks npm at most once a day, prints one line on stderr, and never updates itself. No check under `CI` or without a terminal.
- `~/.openstory/stitch.json` is renamed to `~/.openstory/credentials.json` once.

## `openstory sync`

A one-way mirror. OpenStory writes; the folder is output only and nothing reads it back.

- **Layout:** `<dir>/<organization>/<sequence-slug>/…`, always with an organization level. The user's sign-up organization (the first one they own) is `personal/`; any other uses its slug. `GET /api/v1/organization` answers both.
- **One organization per key.** A device-code key belongs to a user and one organization, so `sync` mirrors that one.
- **Triggers:** a full pass at start (unchanged files skipped by `versionId`), then a sequence syncs again two seconds after its realtime events settle. Realtime is the SSE route `/api/realtime?channels=<sequence ids>`, which takes an `osk_` key; there is no organization-wide channel, so the list is re-read every minute for new or renamed sequences. One connection carries the newest 64 sequences, the route's cap. A pass is always safe to repeat, so a missed event is fixed by the next.
- **`<dir>/.openstory/sync.json`** maps organization ids and sequence ids to folders. A slug change renames the folder; the organization folder is in the map too, so a later chosen name only renames `personal/`. A folder mirrors one server: another `--origin` is refused.
- Shared cast, location and style files are cached in `<dir>/.openstory/cache`, on the same volume, so hard links hold.
- Archived and deleted sequences drop out of the list; their folders are left alone.
- `bun dev` starts it (`scripts/sync-local.ts`) when a data folder is in use, once `openstory login --origin http://localhost:<port>` has stored a key; otherwise it prints that command. `--origin` mirrors an openstory.so library into another `--dir`.
