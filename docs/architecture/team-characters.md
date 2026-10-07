# Team characters (#2017)

A character belongs to the team. A sequence (an episode) never copies one: it
holds a **cast link** that pins the version of the character it uses. A lead
who is in 100 episodes is one character, with one set of looks.

This doc covers the tables, the backfill, every read and write going through
the cast link, the Characters page and the library flag, attaching a library
character to a sequence and what analysis does with the attached cast
(#2050). Still to come: moving an episode to a newer version.

## Data

- **`characters`** — identity: `teamId`, `inLibrary`, the **current** bible
  version (`selectedBibleVersionId`, the one a new sequence adopts) and the
  voice. Bible versions, looks, sheets and voice versions stay keyed by the
  character id.
- **`character_bible_versions`** gains `talentId`. A recast is a new version
  with a different talent; the cast talent is the pinned version's.
- **`sequence_cast`** — one row per character per sequence.
  - `sequenceId`, `characterId`, `scriptCharacterId` (the analysis id, e.g.
    `char_001`), `bibleVersionId` (the pin), `voiceVersionId` (the voice
    pin; null when the character has no voice here), `removedAt`,
    `createdAt`.
  - Unique on (`sequenceId`, `characterId`) and on (`sequenceId`,
    `scriptCharacterId`).
  - Soft-remove from a sequence is the link's `removedAt`. The character
    stays.
- **`sequence_cast_looks`** — one row per look a sequence uses.
  - `castId`, `lookId`, `lookVersionId` (the pin), `selectedSheetVersionId`,
    `pendingPromoteSheetVersionId` (the sheet claim), `sheetStatus`,
    `sheetError`.
  - The sheet pointer is per sequence because a sheet also depends on the
    sequence's style and image model. Sheet versions stay on the look.
- **`character_looks`** keeps identity and its current version
  (`selectedLookVersionId`).

All four FKs on the two new tables are `restrict`: deletes are done in app
code (the #612 rebuild trap).

**Current and pinned are different pointers, not copies.** The character and
the look name their current version. The cast link and the cast look name the
version a sequence uses. Today every write moves both together, because no
character is in two sequences yet. Once one is, an edit from one episode
moves that episode's pin and the current pointer, and leaves the other
episodes where they are.

## One read shape

`scopedDb.characters` reads come through the cast link and are scoped to the
team. Each returns the character **as that sequence casts it**, under the
names the character's own columns had, so callers did not change:

| Field                    | Comes from                               |
| ------------------------ | ---------------------------------------- |
| `sequenceId`             | `sequence_cast.sequenceId`               |
| `characterId`            | `sequence_cast.scriptCharacterId`        |
| `deletedAt`              | `sequence_cast.removedAt`                |
| `selectedBibleVersionId` | `sequence_cast.bibleVersionId` (the pin) |
| the bible fields         | the pinned bible version                 |
| `talentId`               | the pinned bible version's `talentId`    |
| `selectedVoiceVersionId` | `sequence_cast.voiceVersionId` (the pin) |
| the voice fields         | the pinned voice version                 |
| `currentBibleVersionId`  | `characters.selectedBibleVersionId`      |
| `currentVoiceVersionId`  | `characters.selectedVoiceVersionId`      |
| `castId`                 | the link's own id                        |

A look read carries `currentLookVersionId` (`character_looks.
selectedLookVersionId`) next to the pinned `lookVersionId` the same way.
A pin that differs from the current pointer is the "Newer version" notice
(§ Version moves).

A look read (`scopedDb.characterLooks`, and `character.looks`) is the same
idea: `lookVersionId`, the definition, `sheetStatus`, `sheetError`,
`selectedSheetVersionId` and `pendingPromoteSheetVersionId` come from the
sequence's cast look, plus `castLookId`. A look with no cast look is not
returned.

Writes key on `castId` / `castLookId` from the row they just read, never on
the character or look id alone.

**A method takes the sequence when its answer depends on it.** One character
can be cast in several sequences, so "the character's cast link" is not a
thing. The sequence is a required first argument, never a default:

- `characters`: `getById`, `getByIds`, `updateBible`, `softDelete`,
  `restore`, and the lists.
- `characterLooks`: `getById`, `ensureDefault`, `listByCharacter(s)`,
  `syncFromAnalysis`, `create`, `update`, `selectVersion`, `remove`,
  `restore`, `claimSheet`, `failSheetClaim`.
- `characterSheetVariants`: `applyConvergent`, `select`, `promoteIfPending`.

A sequence links a character once (unique index) and a cast holds a look
once, so the sequence and an id name one row.

**About the character itself, with no sequence:** these work for a character
in no sequence, one, or many.

- The voice: `updateVoice`, `stampPreviewUnusable`, `selectVoiceVersion`,
  the voice-claim methods and `getVoice`. They return the voice state, not a
  cast read. The voice workflow's live read is `liveRead.characters.getVoice`.
- The library flag: `setInLibrary`.
- The team reads: `listTeam`, `getTeamCharacter` (§ Characters page).
- A look's definition history (`listVersions`) and a sheet variant by id.

What follows from one character in two sequences:

- **A bible or look edit from one sequence** moves that sequence's pin and
  the current pointer. The other sequence keeps what it pinned.
- **A look added from one sequence** has a cast look in that sequence only.
  Look names are unique among the looks a sequence uses.
- **Removing a look** is the look's own (`character_looks.deletedAt`), so it
  is refused while a scene of any sequence that uses the look wears it. The
  refusal names the scenes of this sequence, or the titles of the others. An
  archived sequence does not refuse: it casts nothing while archived, and a
  scene that points at a removed look keeps wearing it when the sequence
  comes back.
- **The voice is pinned per sequence, like the bible (decided 2026-10-07).**
  `sequence_cast.voiceVersionId` names the `character_voice_versions` row a
  sequence speaks in; a cast read's `voiceId`, `voiceDescription`,
  `voicePreviews` and `selectedVoiceVersionId` come from it, and
  `currentVoiceVersionId` is the character's own pointer. Every voice
  pointer write takes the sequence it was made from as its first argument
  and moves that sequence's pin with the current pointer (`updateVoice`,
  `selectVoiceVersion`, `promoteVoiceClaimIfPending` — the voice workflow's
  payload already carries `sequenceId`); the other sequences keep what they
  pinned, and their dialogue and clips do not move. `updateVoice(null, …)`
  is the one write made from no sequence (the library letting a character go
  that nothing casts): only the current pointer moves. Attach pins the
  current voice version. `useVoice` stays on the character.
- **A provider voice is held while anything names it** (`voiceReferences`
  in `characters.ts`, the one list behind `getVoiceReferenceCount` and
  `getOwnVoiceHolds`): a live cast link's pin — not removed, in a sequence
  that is not archived — a character's current pointer, or a talent. So a
  recast or voice change from episode 50 leaves episodes 1–49 recording in
  the old voice, and that voice is released only when the last of them
  moves on. `releaseCharacterVoice(scopedDb, character, sequenceId, …)`
  counts its own references first (the current pointer and that sequence's
  pin, where they name the voice) and passes them as `heldBy`, so the
  provider delete still comes before the row write and another sequence's
  pin still blocks it.
- **The voice goes only when nothing holds the character.** "Held" has one
  meaning (`castElsewhere` in `characters.ts`): the library flag, or a cast
  link that is not removed in a sequence that is not archived. The list and
  the character page count a sequence the same way.
  - Removing a character from a sequence, or archiving the sequence,
    releases the saved voice unless something else holds the character
    (`characters.getHeldElsewhere`).
  - Taking a character out of the library while no sequence casts it
    releases the voice first (`setCharacterInLibrary` in `cast-edit.ts`):
    after that no page can reach the character. Provider first, row second
    (`elevenlabs.md`); a failed release leaves the flag set.
  - Unarchiving finds the character with no saved voice, as it does today.
- **Sheet variants are the look's**, with no sequence on the row. A sheet
  parked as divergent by one sequence's run is listed for every sequence
  that uses the look. Not changed here.

Nothing in the app creates a second link yet. The db test
`one character in two sequences …` (`sequence-cast-crud.test.ts`) writes one
by hand and runs list, get, edit, sheet claim, landing, remove and sequence
delete through both.

A link whose pinned bible version does not exist throws on read. The pin has
no FK, so this is the check.

The looks and sheet-variant modules are scoped to the team like the
characters module. The voice writes that read the character first
(`updateVoice`, `selectVoiceVersion`, `createPendingVoiceClaim`, `getVoice`)
are too. The methods keyed on a voice version id alone are not yet.

## Characters page and the library

- **`/characters`** is on the sidebar. Its Characters tab lists the team's
  characters (`?show=all|library`); its Talent tab is the talent library.
  `/talent` redirects to `/characters?tab=talent`; `/talent/$id` is
  unchanged. Signed out, the page opens on the Talent tab (the public
  catalogue) and the Characters tab asks to sign in.
- **The list** is `characters.listTeam`: one grouped read over the cast
  links, with no stored column.
  - Order: the most recently changed sequence casting the character
    (`max(sequences.updated_at)`), then how many sequences cast it.
  - A removed link and an archived sequence do not count.
  - A character nothing casts and the library does not hold is left out.
    Its rows stay; nothing deletes them yet.
  - The picture is the default look's sheet as the latest sequence that has
    one selected it.
  - Not paged: the page and the MCP tool load the whole list (about 1.1 MB
    at 2,500 characters). Known limit. The grid virtualizes its rows.
- **`/characters/$id`** shows the sequences that cast the character and
  embeds the sequence detail view (`CharacterDetailView`) for the one in
  `?sequence=`, or the latest. Looks, sheets and edits there are that
  sequence's. A character no sequence casts shows its name and description
  only: there is no pin to edit through.
- **Shot count** is on that page only. A shot is matched to a character by
  scene tags in memory, one sequence at a time
  (`getTeamCharacterShotCountsFn`).
- **Add to Library** sets `characters.in_library`; Remove from Library
  clears it. Nothing is copied and no talent is made. The flag keeps the
  character listed, feeds the Library filter and `list_library_characters`,
  and decides what the `@` picker offers.

## Attach and `@` references (#2050)

A character is reused only when the writer says so. Analysis never reads the
team library; a library character reaches a sequence by an attach, and the
script then names her like any cast member.

- **Nothing is stored in the text.** The script holds her name in capitals,
  as it does for every character; the sequence's cast link says what it is
  bound to. No `@`, no id, no serializer change (the same rule as elements
  and the studio's mention extension, `src/ui/text-editor/mention/`).
- **The attach** is `characters.attach(sequenceId, id)`: one `sequence_cast`
  link pinning her **current** bible version, and one cast look per live look
  she has, each pinned at its current version and sheet-less (a sheet depends
  on the sequence's style and image model, so the first run draws them). Her
  script id is `char_<name>` uniqued against every link of the sequence,
  removed ones included. The event is `character.attached`. Nothing is
  copied.
- **Refused** unless she is in the library (`ValidationError`), and while a
  live cast member of the sequence already has her name (`ConflictError`):
  the text could not tell two ADAs apart. Two characters may still share a
  plain name when analysis made them; nothing refuses that. Attaching a
  character the sequence already casts is idempotent, and brings back a
  removed link.
- **Surfaces.** The script editor's `@` dropdown lists the library characters
  not cast here, most recently used first (`libraryMentionItems`, the
  `listTeam` order), as pick-only rows: picking one inserts her name in
  capitals and attaches her (`attachLibraryCharacterFn`); on the create
  screen the pick goes onto the draft (`castCharacterIds`) and
  `createSequences` attaches before the storyboard trigger, so the first
  analysis reads her. A pick-only row never pills: a plain name is prose until
  she is attached. The cast panel's **Add from library** attaches with no
  script change. API: a string in `create_sequence`'s `characters` names a
  library character first (id or name; two of one name is a `CONFLICT` that
  asks for the id), then talent. MCP: `add_character_to_sequence`.
- **Detach** is the existing Remove (soft, the link's `removedAt`).
- **A rename** in a later version leaves the script saying the old name until
  the episode moves version (version moves, a later PR).

## Analysis reads the attached cast (#2050)

- **Snapshot.** `triggerStoryboard` freezes the sequence's live cast onto the
  payload (`cast: AttachedCastSnapshot[]`, required on the storyboard,
  analyze-script and scene-split inputs): each as the sequence casts her
  (`characterToBible`, look ids are `character_looks` ids) with `shared` —
  the library or another sequence holds her too (`getHeldElsewhere`). No
  mid-run read; a payload without the field fails at the top
  (`queuedBeforeCast`).
- **The bibles call** sees a `<CAST>` block shaped like `<ELEMENTS>`
  (`formatCastBlock`): script id, name, appearance, look names. It echoes
  the ids and look names of the characters the script uses, adds a look only
  when none fits, and makes a new character for any name it cannot place.
  With nobody cast the block is absent and the message is byte-for-byte what
  it was, so the recorded `script-bibles` fixture replays.
- **A shared character is linked, never edited.** `applyAttachedCast`
  replaces her entry with the snapshot (the pinned bible wins over anything
  the model wrote), keeps her looks by id, appends the looks the model named
  that she lacks, and re-points scene picks from a slug to the look it named.
  `create-cast-records` skips `characters.create` for her (no bible version)
  and calls `characterLooks.linkFromAnalysis`: a cast look where this
  sequence lacks one (pinned at the look's current version), matched by id or
  by name among every live look she has, cast here or not; a new look for a
  name she lacks; nothing rewritten, nothing removed. She is left out of
  talent matching: her talent is on the pinned version.
- **A character only this sequence holds** (not in the library, cast nowhere
  else) is re-analysed as before: bible rewritten, looks synced by name,
  unused analysis-made looks retired. `shared` is read at the trigger, so a
  character attached elsewhere mid-run is still this run's to rewrite.
- **Plain names.** Scene tags are still by name (`reconcileSceneTags`), so two
  cast characters with one plain name are both tagged where it appears.
  Unchanged here.
- **Save as talent** is what Add to Library did before: it copies the
  character, as one sequence casts it, into a new talent
  (`saveCharacterAsTalentFn`). It is how a character reaches the recast
  picker, the new-sequence talent picker and the studio today. It stays
  until #2018 defines what a talent is. Hidden for a talent-cast or
  voice-only character, as the old button was.
- **A character the page cannot list** (not in the library, cast in no live
  sequence, another team's, or gone) reads "Character not found" with a way
  back, not an error.
- MCP: `list_library_characters`.

## Writes

- **New character** (`characters.create`): one batch inserts the character
  (with the team), its first bible version (with the talent), the cast link,
  the default look, its first look version and the cast look.
- **Bible edit** (`bibleWrite`): appends a version carrying the talent, moves
  the current pointer and the link's pin, and revokes the cast's sheet claims
  when a field the sheets read moved.
- **Recast** (`updateBible` with `source: 'recast'` and the `talentId`): ONE
  bible version, by the person who recast, carrying the new talent and the
  appearance copied from it. The claims are revoked whether or not the
  talent moved. `bibleWrite` takes the talent as a required argument, so
  every writer says who plays the character.
- **Look edit** (`lookDefinitionWrite`): appends a look version, moves the
  look's current pointer and the cast look's pin.
- **Remove / restore**: the link's `removedAt`.
- **Sheet claim, promote, fail, pick**: on the cast look. See
  `character-looks.md` § Sheets and claims; only the row changed.
- **Talent changes** revoke the claims of the cast links whose pinned bible
  version names that talent (`castOfTalent`).
- **Deleting a sequence** removes its cast looks and links, then only the
  characters nothing else holds: not in the library and in no other sequence
  (`charactersOnlyIn`). The ids are read before the batch, because the links
  that say so go first. See § Hard deletes.

## Hard deletes

Nothing cascades from a sequence to a character, or from a character to its
rows. Every foreign key into `characters` is `no action` or `restrict`, so a
delete that forgets a child fails instead of taking rows with it.

- `deleteCharactersStatements(db, where)` (`src/cast/server/db/characters.ts`)
  is the one list of what a character owns: bible versions, look versions,
  looks, sheet variants, voice versions, then the character. The cast looks
  and links go before it (`deleteCastStatements`).
- Two methods use it, each in one batch: `characters.delete` (one of the
  team's characters) and `sequences.delete` (the characters that sequence
  alone holds). Neither has a caller in the app today: a sequence is
  archived, not deleted.
- **Team.** Both are scoped to the team in every statement. Another team's
  id deletes nothing.
- **Voices.** A saved voice is an account-wide provider slot, freed only
  through `releaseVoiceIfUnreferenced` (`elevenlabs.md`), which a db method
  cannot call. So both deletes are **refused** while they would strand one
  (`assertVoicesReleased`).
  - What counts (`voiceIdsHeldOnlyBy`): a voice id on **any** voice version
    of a character being removed, selected or not, that is not released, is
    not a Seed voice (`voiceProviderOf`), and that no surviving row points
    at (another character's selected version, or a talent). An unselected
    version with `releasedAt` null is the only record of a slot whose
    provider delete failed, so it counts.
  - The caller reads the ids (`characters.getVoiceIdsToRelease`,
    `sequences.getVoiceIdsToReleaseOnDelete`), drops each live pointer with
    `releaseCharacterVoice`, runs the rest through
    `releaseVoiceIfUnreferenced`, and passes the ids to `delete` as
    `releasedVoiceIds`. An id it did not name stops the delete.
  - The ids are named, not re-read from `releasedAt`, because a release does
    not always stamp it (a voice that takes no slot, an unconfigured or
    refused key). Re-reading would refuse those deletes for good.
  - A character kept by the library or by another sequence is not removed,
    so its voices are not in the way.
- Deleting a team is refused while it has characters (`characters.team_id`,
  no action).

## Legacy columns

The four cast columns on `characters` (`sequence_id`, `character_id`,
`talent_id`, `deleted_at`), their indexes and the unique index are gone, and
`team_id` is NOT NULL. Nothing writes or reads them, and the backfill that
placed an older worker's rows went with them.

Still there, unread: the sheet state on `character_looks`
(`legacy*` in Drizzle). `sheet_status` is written at insert only because it
is NOT NULL. Dropping those four is a plain `DROP COLUMN` each, for a later
PR.

## Migrations

**Expand** (PR #2022). `20261004082223_team_characters_cast` is generated:
two `CREATE TABLE`, three `ADD COLUMN`, indexes.
`20261004082252_backfill_team_characters_cast` is hand-written data SQL.

- A cast link reuses its character's ULID. A cast look reuses its look's.
- Every pointer, status and in-flight claim is copied as it is. No stored
  digest moves and nothing regenerates.
- The talent goes on the version each character is on. Older versions keep
  null: who played the character then was never recorded.
- A character with no bible version gets one first, as the #1600 backfill
  made them, so `sequence_cast.bibleVersionId` can be NOT NULL.

**Contract** (the column drop). Two files, and the order matters.

1. `20261006232126_loosen_character_children` — generated, unedited. It
   rebuilds `character_bible_versions`, `character_sheet_variants` and
   `character_voice_versions` so their foreign key to `characters` is
   `no action`. All three are leaves: nothing references them, so their own
   rebuild cannot cascade.
2. `20261006232156_drop_character_legacy_columns` — custom
   (`bun db:generate --custom`). Drizzle's own table definition, column list
   and index statements, in a different order:
   - `PRAGMA defer_foreign_keys = ON` first. D1 runs a migration file in one
     transaction, where `PRAGMA foreign_keys=OFF` is ignored. The defer
     pragma lasts for that transaction only, so it is in this file.
   - A **guard**: it counts foreign keys into `characters` that act on delete
     (cascade, set null, set default), across every table, and fails the file
     unless that is zero. It uses `GLOB`, not `LIKE … ESCAPE`, so the file
     has no backslash for a statement splitter to read differently.
   - Copy out, drop `characters`, **create it again**, copy back, drop the
     copy. Not a rename: SQLite counts a violation per child row when the
     table is dropped and takes one off only when a row is inserted into a
     table of that name, so a rename leaves the count above zero and the
     commit fails.
   - The copy back names its columns. `INSERT … SELECT *` between identical
     tables can take SQLite's bulk path, which skips that bookkeeping.

Why the guard and migration 1 exist: with checks deferred, a `cascade` child
is deleted when the parent is dropped and the transaction still commits, and
`restrict` does not stop it (it behaves like `no action`). Without migration
1, migration 2 reported success and emptied the sheet and voice tables.

What was run (`wrangler d1 migrations apply --local`, one file per call):

- Local dev data, and a copy of production (2,095 characters, 2,097 bible
  versions, 2,132 sheet variants, 251 voice versions): every row of the
  eight tables identical before and after, minus the dropped columns; all
  other tables' counts unchanged; `foreign_key_check` empty.
- Migration 2 without the pragma: fails, rolls back, nothing lost.
- Drizzle's statements as emitted (copy, drop, rename), with the pragma:
  fails at commit, rolls back, nothing lost.
- Migration 2 without migration 1: stopped by the guard, nothing lost.

On remote D1:

- The PR preview applied both files to an empty remote D1.
- On 2026-10-07 both files were applied with `migrations apply --remote` to
  a throwaway remote D1 loaded with a production export (188,226 rows):
  about 50 ms each, all eight tables identical in count, no foreign key
  violations, no orphans, both files recorded. The two files copy about
  4,500 child rows once and the character rows twice.
- Not shown on remote: the out-of-order control (the guard stopping
  migration 2 when migration 1 has not run). That was run on local D1 only.

`bun db:generate --custom` copies the previous snapshot, so migration 2's
`snapshot.json` is the one drizzle-kit wrote for the generated form of the
same change, with the custom migration's id. `bun db:generate` reports no
changes after it.

## The deploy window

Nothing is applied to production by hand. The merge's deploy runs the two
files, one after the other, and then swaps the worker. The window is the
minutes between the first file and the new worker going live. For all of it
the previous worker (the expand PR's code) is serving.

**From file 1** (children no longer cascade):

- That worker's hard deletes, `characters.delete` and `sequences.delete`,
  relied on the cascade to remove sheet variants and voice versions. With
  sheets or voices present they now fail on the foreign key. Neither has a
  caller in the app, so nothing a user does reaches this. The cast panel's
  Remove is a soft remove and is not affected by file 1.

**From file 2** (`characters` has no `sequence_id`, `character_id`,
`talent_id` or `deleted_at`). That worker's reads do not select those
columns, so everything it shows still works. Its writes that name them fail
with "no such column", in one batch each, so nothing is half written:

- **Adding a character**, by hand or in analysis (`create-cast-records`).
- **Any bible edit or recast**, and a re-analysis onto an existing character.
- **Removing or restoring a character** (the soft remove).
- Its **`sequence_cast.backfill` cron pass** would fail the same way if it
  reached those columns; it counts first and finds nothing to do.

An analysis run recovers only if its step is still retrying when the new
worker goes live. `create-cast-records` sets no retry policy, so it has
Cloudflare Workflows' default: five retries, ten seconds apart to start and
doubling, about five minutes in all (from Cloudflare's documentation, not
measured here). A run that uses them up fails, and the user starts it again.

Still working throughout: voice writes, look edits, sheet claims and
landings, everything on the cast tables.

If file 2 fails after file 1 applied, the deploy stops there and the previous
worker keeps serving. Production stays in the "from file 1" state, which
costs nothing a user can reach, until a fix to file 2 is merged and the next
deploy runs it. A failed file 2 rolls back whole: no `__new_characters` or
guard table is left when it ran as one transaction.

A rollback of the worker to the expand PR's code is not possible after file
2: that code cannot create or edit a character.

## Open question

Deleting a talent sets `character_bible_versions.talent_id` to null on every
version that named it (`ON DELETE SET NULL`), pinned and historical alike. A
sequence sees what it saw before: the character is uncast. But it rewrites
rows that are otherwise append-only, and history loses who played the
character. Unchanged here; Tom to decide between keeping it, a pointer with
no FK, or refusing the delete while a version names the talent.
