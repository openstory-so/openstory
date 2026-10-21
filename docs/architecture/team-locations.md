# Team locations (#1695)

A location belongs to the team. A sequence never copies one and never keeps
a version of one: it holds a **link**, and reads the location as it is now.
A set used in 100 episodes is one location, with one bible and one sheet. An
edit from any sequence changes it in every sequence; what that edit stales
in each one is staleness's job (`prompt-staleness-dependency-graph.md`),
never a pointer's.

This is the location twin of team characters (`team-characters.md`, #2017).
The old location library is gone: a library location became a location.
There are no rooms or looks. A room is its own location.

## Data

- **`locations`** (the SQL table is still `sequence_locations`; a rename
  would rebuild the bible versions that point at it). Identity: `teamId`,
  the current bible version (`selectedBibleVersionId`), the sheet pointer
  (`selectedReferenceVersionId`), the sheet claim
  (`pendingPromoteReferenceVersionId`), `referenceStatus`, `referenceError`,
  and `deletedAt` (deleted from the team). Bible versions, sheet versions and
  photos are keyed by the location id.
  `legacyLibraryReferenceHash` is read only to verify an old sheet digest
  (see § Migration).
- **`sequence_location_links`**: one row per location per sequence, holding
  only what is the sequence's:
  - `sequenceId`, `locationId`, `scriptLocationId` (the analysis id, e.g.
    `loc_001`; scene environment tags resolve through it), the first mention
    (`firstMentionSceneId`, `firstMentionText`, `firstMentionLine`),
    `removedAt`, `attached`, `createdAt`.
  - `scriptConsistencyTag`: the tag the script knows the place by, when that
    is not the location's own. Set when matching bound a script location to
    a team location, and when a link was re-pointed by Replace. Scenes keep
    the script's tag, so a read through the link answers with it. Null when
    the location's own tag is the script's.
  - `attached`: the writer picked the location for this sequence, added
    it by hand (`locations.create` with `source: 'edit'`), or matching
    bound a script location to one they picked. Analysis making it here
    leaves the flag false. Analysis never rewrites an attached location.
  - Unique on (`sequenceId`, `locationId`) and on (`sequenceId`,
    `scriptLocationId`).
  - Soft-remove from a sequence is the link's `removedAt`. The location
    stays.
- **`location_reference_photos`**: a photo uploaded as input for a
  location's sheet. Any number per location. `locationId`, `url`, `path`.

`location_bible_versions` carries `rendering`. `location_sheet_variants` has
`locationId` (it was `parentId`) and no `parentType`: there is one kind of
parent now.

Every foreign key into `locations` is `restrict` or `no action`, and so is
the link's key to `sequences`: deletes are done in app code (the #612
rebuild trap). A team delete is refused while the team has locations.

## One read shape

`scopedDb.locations` (`src/cast/server/db/locations.ts`) is scoped to the
team in every statement. A read through a sequence returns the location at
its current version plus the link's own fields, under the names the
location's own columns had, so callers did not change:

| Field                    | Comes from                                          |
| ------------------------ | --------------------------------------------------- |
| `linkId`                 | the link's own id                                   |
| `sequenceId`             | the link                                            |
| `locationId`             | the link's `scriptLocationId`                       |
| `firstMention*`          | the link                                            |
| `attached`               | the link                                            |
| `deletedAt`              | the link's `removedAt`                              |
| `consistencyTag`         | the link's `scriptConsistencyTag`, else the bible's |
| `selectedBibleVersionId` | the location                                        |
| the bible fields         | that version                                        |
| `reference*`             | the location's live sheet version                   |

`consistencyTag` through a link is the script's tag when the link has one:
scenes keep the tag the script gave the place (`continuity.environmentTag`),
and `matchLocationsToScene` finds the location by it after a bind or a
Replace. An attach leaves it null. A bible edit made through a sequence
diffs against the location's own bible (`ownOf`), so the script's tag is
never written into the team's bible.

A read from no sequence (`getCurrent`, `getCurrentByIds`, `get(null, id)`)
is the same without the link fields, and its `consistencyTag` is the
location's own. Its `deletedAt` is the location's own
(deleted from the team), and a deleted location is not returned.

**A method takes `sequenceId` only when the answer or the write is the
link's, or when it records a sequence event.**

- Through a link: `getById`, `getByLocationId`, `list`, `listDeleted`,
  `listBibleVersionsBySequence`, `listWithReferences`, `getByIds`,
  `getShotIdsForLocation`, `getAnalysisMayNotRewrite`.
- The link's own writes: `create`, `createBulk`, `attach`, `replace`,
  `softDelete`, `restore`.
- A write that records an event takes `sequenceId | null`: `updateBible`,
  and `locationSheetVariants.select`. From no sequence it is the same write
  with no event.
- Everything else is the location's own and takes no sequence: `listTeam`,
  `getTeamLocation`, `getCurrent`, `listBibleVersions`,
  `getUsedInAnySequenceOrArchive`, the photo methods, `createForTeam`, the
  sheet claim (`claimReference`, `claimReferenceIfUnmoved`,
  `failReferenceClaim`), `softDeleteForTeam`, `restoreForTeam`.

Another team's location is not found by any of them.

What follows from one location in two sequences:

- **A bible edit from one sequence** changes the location. The other
  sequence's sheet check, prompts, stills and clips read stale by the hashes
  that already exist, and its own Update redraws them.
- **There is one sheet.** A new sheet version, or a pick of another version,
  is seen by every sequence that uses the location.
- **Sheet variants are the location's**, with no sequence on the row. One
  parked as divergent by a run from one sequence is listed for every
  sequence.

## Attach

`locations.attach(sequenceId, id)` writes one link. Nothing is copied and
nothing is drawn: the sequence reads the bible and the sheet as they are.

- The script id is `loc_<name>`, made unique against every link of the
  sequence, removed ones included.
- The link is `attached`. The event is `location.attached`.
- Attaching a location the sequence already uses returns it as it is.
  Attaching one the sequence removed brings the link back and sets
  `attached`: the writer picked it again.
- Refused unless the sequence is the team's (`NotFoundError`, checked in the
  db method), and while a live location of the sequence already has its name
  (`ConflictError`, `assertNameFree`): a scene names its place in the
  slugline, and two of one name could not be told apart. Restore and Replace
  run the same name check.

## Replace (recast)

"Replace" re-points the link at another of the team's locations
(`locations.replace`, called by `recastLocation` in
`src/cast/server/cast-generation.ts`).

- The link keeps its script id, so every scene set there now reads the
  other place. It becomes `attached`, and keeps the tag the scenes had
  (`scriptConsistencyTag`).
- No sheet is drawn and no claim is taken. The replacement must already
  have a sheet (`ValidationError` otherwise).
- Refused while the replacement is already a live location of the sequence
  (`ConflictError`), and by the name check. A removed link to the
  replacement is deleted in the same batch, since it would break the unique
  key.
- The event is `location.replaced`.
- After the link moves, the trigger snapshots the shots set at the location
  and starts `RecastLocationWorkflow`, which only re-renders those shots.
  If the trigger throws, the link has still moved and the shots read stale.

## Matching binds a link

Script analysis still matches script locations against the locations the
writer picked for the sequence (`sequences.suggestedLocationIds`): the same
LLM call and prompt (`LocationMatchingWorkflow`). A match is now a link.

- `buildLocationInsert` (`cast-records.ts`) puts the matched team location's
  id on the entry as `boundTo`.
- `locations.createBulk` links a `boundTo` entry and makes nothing. The link
  is `attached`, takes the script id and the first mention, and stores the
  script's tag as `scriptConsistencyTag`.
- The script id can name one location in a sequence. A link that held it
  for another location is taken over (when the sequence had no link to the
  bound location) or deleted (when it had). That other location stays the
  team's.
- `LocationBibleWorkflow` draws no sheet for a bound or attached location,
  or for one `createBulk` marks `held` (another sequence has used it). The
  flag is the upsert's own decision, carried on that step's result.
- A picked location is matched whether or not it has a sheet yet. The
  matching run reads the picks once and waits for no sheet.

## Analysis never rewrites an attached or shared location

`analysisMayNotRewrite` (`src/cast/server/db/locations.ts`) is the one place
this rule lives. It is true when this sequence's link is `attached`, or when
any other sequence has a link to the location, a removed link or an
archived sequence included.

`locations.create` and `createBulk` ask it on every call. For a held
location the link is brought back, a bulk pass refreshes its first mention,
and the bible analysis wrote for it is dropped. `createBulk` sets `held`
on that row, and the sheet fan-out draws nothing for it. A location
analysis made here, that only this sequence has ever used, is re-analysed
as before: a new bible version when a field moved, and `held` is false.

## Reference photos

Photos are input to the sheet (`listPhotos`, `addPhotos`, `removePhoto`).

- Every photo goes through the likeness gate first
  (`attachLocationReferenceImages` → `requireUploadRights`).
- The sheet trigger snapshots the photo URLs onto the payload
  (`referencePhotoUrls`, sorted). The sheet prompt takes them
  (`buildLocationSheetPrompt(entry, referencePhotoUrls)`).
- The set of photos is in the sheet hash. Order is not.
- Adding or removing a photo clears the sheet claim, so a run in flight
  parks its result instead of landing it.
- Adding or removing a photo does not start a sheet run.
  `finalizeLocationUploadFn` calls `addPhotos`. The sheet stays as it is
  until Generate.

## Rendering

`rendering` is one required line on the location bible: what the place is
rendered as ("Photoreal live action", "3D animated, Pixar-like"). It is the
only thing a location sheet takes from a style. The sheet prompt and the
sheet hash read no sequence style.

- Every bible writer passes through `renderingForLocation`
  (`src/cast/rendering.ts`): a blank one throws a `ValidationError`, on
  create and on edit.
- Analysis fills it from the sequence style's medium, else photoreal
  (`renderingOfStyle`). It is not on the LLM's wire schema.
- It is in `LOCATION_SHEET_BIBLE_FIELDS`, so an edit to it revokes the sheet
  claim and stales the sheet. The shot prompts do not read it.

## Locations page and runs from no sequence

- `/locations` lists the team's locations (`locations.listTeam`): one
  grouped read over the links, with no stored column. Order: the most
  recently changed sequence using it, then how many sequences use it. A
  removed link and an archived sequence do not count. A location nothing
  uses is listed last. Signed out, the page asks to sign in: there are no
  public locations.
- A location made there (`createTeamLocation` → `locations.createForTeam`)
  has no link and writes no event. Its first bible version is
  `source: 'edit'`, by the user.
- A sheet run from no sequence carries `sequenceId: null`
  (`LocationSheetWorkflowInput`). What changes:
  - It reports on the location's own channel, `locationChannelId(null, id)`
    = `location:<id>`. Through a sequence the channel is the sequence's.
  - It stores under `<team>/team/<location>/`.
  - The image model is the live sheet version's, else the default.
  - No sequence event is written (the bible edit, the sheet pick).

## Deletes

- **Remove from a sequence** is soft: the link's `removedAt`
  (`softDelete`). **Restore** clears it, and clears a team delete too.
- **Delete from the team** (`deleteTeamLocation` → `softDeleteForTeam`) is
  soft: `deletedAt` is stamped and the location leaves the list, the pickers
  and every read from no sequence. Refused while any sequence, archived
  ones included, has a link to it that is not removed. The write is one
  UPDATE with that condition, so a sequence that attaches it between a check
  and the write still stops it. `restoreForTeam` clears the stamp.
- **Hard delete.** Nothing cascades. `deleteLocationsStatements` is the one
  list of what a location owns: photos, bible versions, sheet versions, then
  the location. The links go first (`deleteLocationLinksStatements`).
  `sequences.delete` uses them for the locations that sequence alone ever
  used and the writer did not attach (`locationsOnlyIn`, read before the
  batch because the links that say so go first).

## Migration

`20261013050454_team_locations` is one hand-written file. D1 runs a file as
one transaction, so no row can be written between the backfill and the
rebuild. In order:

1. A link per existing location, under the location's own ULID. The old
   `deleted_at` (removed from its sequence) becomes the link's `removed_at`.
   None is `attached`.
2. A bible version for a location from before bible history, under its own
   ULID. Then `rendering` on every bible version: the sequence style's
   medium, else the medium its system template gets, matched by style name,
   else "Photoreal live action". The same rule as the character backfill.
3. `sequence_locations` is rebuilt without its sequence columns and with
   the team (the location's sequence's team). This is the guard-and-defer
   rebuild from `AGENTS.md` § D1 table-rebuild trap: a guard that fails the
   file if any foreign key into the table acts on delete,
   `PRAGMA defer_foreign_keys = ON`, then copy out, drop, create again and
   copy back with named columns.
4. Each team library location becomes a location under its library row's
   ULID, with a bible version (name, description, photoreal). Its current
   image becomes a sheet version under the same id. Its uploaded images
   become `location_reference_photos`.
5. `location_sheet_variants` loses `parent_type`.
6. `location_sheets` and `location_library` are dropped.

**Public templates are dropped.** A library row that was public or a
template is not carried over, nor are its images or parked sheets.

**Old sheet digests.** A sheet stamped before this change hashed the
sequence's style and, when drawn from a library location, that library
reference's hash. So that such a sheet does not read stale on deploy:

- The rebuild keeps the library reference's hash on the location as
  `legacy_library_reference_hash`.
- `locationSheetInputHashMatches` accepts the current digest, and the
  shapes stamped before (`pre-1695`, `pre-1785`, `named`, and `library` for
  a sheet that was a library location's own). The caller passes the legacy
  parts (`LegacyLocationSheet`): the stored reference hash and the style of
  the sequence the check is made from.
- From no sequence there is no style, so the shapes that read one are not
  checked.
- The legacy shapes and the column go after `LEGACY_HASH_UNTIL`
  (2026-12-31).

**Proof** (2026-10-13, sample rows): the file was run as one transaction on
scratch SQLite, and through `wrangler d1 migrations apply --local` on a
scratch local D1 that had every earlier migration and hand-made rows of
each kind: a location with a bible version and a selected sheet, one from
before bible history, one removed from its sequence, one drawn from a
library reference, a team library location with two uploaded images and a
parked sheet, one with no image, and a public template with a parked sheet.
Both runs: every location kept its id and got its sequence's team; one link
each, the remove carried to `removed_at`; every bible version has a
rendering; the library locations became locations with their sheet and
photos; the template and its parked sheet are gone; `foreign_key_check`
empty. Control: with a cascading foreign key planted on
`sequence_locations` the guard fails the file and nothing changes.

**Proof** (2026-10-14, production copy): the same file, on a throwaway
SQLite database loaded with the 2026-10-07 production export (schema, then
rows). That export's last recorded migration is
`20261004082252_backfill_team_characters_cast`, so the eight files from
`20261006232126_loosen_character_children` through this one were applied
after the load, each file as one transaction. Load had no foreign-key
violations. After: 2,732 sequence locations each kept its id, took its
sequence's team, and got one link (the old `deleted_at` on
`removed_at`, none `attached`, the location's own `deleted_at` null, bible
pointer `coalesce(selected, own id)`). 27 team library locations became
locations under their own ids; the 23 that had an image became a sheet
version; 43 uploaded images became reference photos. 3 public or template
library rows were not carried. Bible versions went from 2,735 to 2,762,
the 27 new ones, and every version has a rendering. All 2,763 sheet
variants stayed, plus the 23 library images; `parent_type` is gone and
`portrait_url` is present. `location_library` and `location_sheets` are
gone. `foreign_key_check` empty. Not run on a remote D1. The PR-preview
deploy runs it on an empty remote D1.

## The deploy window

The migration runs before the new worker serves. Until the swap, the
previous worker's location writes fail: they name columns and tables that
are gone (`sequence_locations.sequence_id`, `location_library`,
`location_sheets`, `location_sheet_variants.parent_type`). A write fails
whole, in its batch, so nothing is half written. A sheet payload queued
before the change fails once at the top of the run
(`assertQueuedWithLocationRendering`, "Run it again").

## Known limits

- **The team list is not paged.** `listTeam` loads every location.
- **Two locations of one plain name.** Attach, Restore and Replace refuse a
  name a live location of the sequence already has. Analysis does not pass
  through that check and may still make two.
- **A sheet stamped before `rendering` reads stale from no sequence.** The
  old digest hashed a sequence's style, and the Locations page has none to
  verify it with. From its own sequence it still reads fresh. The same sheet
  reads stale from a second sequence that attaches the location with another
  style, until it is redrawn once.
- **`LocationBibleWorkflow` does not snapshot photos.** It has no trigger
  of its own, so it sends `referencePhotoUrls: []`. It arises when a
  location analysis made is given photos and the script is analysed again:
  the sheet is redrawn without them and reads stale.
