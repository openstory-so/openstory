# Team characters (#2017)

A character belongs to the team. A sequence (an episode) never copies one: it
holds a **cast link** that pins the version of the character it uses. A lead
who is in 100 episodes is one character, with one set of looks.

This doc covers the first step: the tables, the backfill, and every read and
write going through the cast link. Nothing a user sees has changed yet. The
library, moving an episode to a newer version, and analysis that reads the
team roster come in later PRs.

## Data

- **`characters`** — identity: `teamId`, `inLibrary`, the **current** bible
  version (`selectedBibleVersionId`, the one a new sequence adopts) and the
  voice. Bible versions, looks, sheets and voice versions stay keyed by the
  character id.
- **`character_bible_versions`** gains `talentId`. A recast is a new version
  with a different talent; the cast talent is the pinned version's.
- **`sequence_cast`** — one row per character per sequence.
  - `sequenceId`, `characterId`, `scriptCharacterId` (the analysis id, e.g.
    `char_001`), `bibleVersionId` (the pin), `removedAt`, `createdAt`.
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
| `castId`                 | the link's own id                        |

A look read (`scopedDb.characterLooks`, and `character.looks`) is the same
idea: `lookVersionId`, the definition, `sheetStatus`, `sheetError`,
`selectedSheetVersionId` and `pendingPromoteSheetVersionId` come from the
sequence's cast look, plus `castLookId`. A look with no cast look is not
returned.

Writes key on `castId` / `castLookId` from the row they just read, never on
the character or look id alone.

**Not done yet:** the methods that take only a character id or a look id
(`getById`, `updateBible`, `softDelete`, `claimSheet`, …) resolve the
character's one cast link. They **throw** when a character has more than one
(`onlyLink` / `oneLinkEach` in `src/cast/server/db/sequence-cast.ts`), so a
second link cannot be read or written through the wrong episode. A sequence's
own list throws too, because looks are still read by character id. The PR
that lets a second sequence cast a character must give those methods the
sequence first.

A link whose pinned bible version does not exist throws on read. The pin has
no FK, so this is the check.

The looks and sheet-variant modules are scoped to the team like the
characters module. The voice-version methods are not yet: they are reached
only after the character has been read.

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
- **Voices.** A saved voice is an account-wide provider slot, freed only
  through `releaseVoiceIfUnreferenced` (`elevenlabs.md`). A db method cannot
  call the provider, so both deletes are **refused** while a character they
  would remove still has a voice id on its selected voice version
  (`assertVoicesReleased`). The caller releases each voice first
  (`releaseCharacterVoice`), then deletes.
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
     unless that is zero.
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

Not run: anything on remote D1. Its CPU limit is not exercised locally; the
two files copy about 4,500 child rows once and the character rows twice.

`bun db:generate --custom` copies the previous snapshot, so migration 2's
`snapshot.json` is the one drizzle-kit wrote for the generated form of the
same change, with the custom migration's id. `bun db:generate` reports no
changes after it.

## The deploy window

Migrations run before the new worker is live. For that minute the previous
worker (the expand PR's code) runs against a `characters` table with no
`sequence_id`, `character_id`, `talent_id` or `deleted_at`. Its reads do not
select those columns, so everything it shows still works. Its writes that
name them fail with "no such column", in one batch each, so nothing is half
written:

- **Adding a character**, by hand or in analysis (`create-cast-records`). The
  workflow step retries and succeeds once the new worker is live.
- **Any bible edit or recast**, and a re-analysis onto an existing character.
- **Removing or restoring a character.**
- Its **sequence delete** and its **`sequence_cast.backfill` cron pass** would
  fail the same way if they reached those columns. The cron pass counts
  first and finds nothing to do; sequence delete has no caller.

Still working in that minute: voice writes, look edits, sheet claims and
landings, everything on the cast tables.

A rollback of the worker to the expand PR's code is not possible after this
migration: that code cannot create or edit a character.

## Open question

Deleting a talent sets `character_bible_versions.talent_id` to null on every
version that named it (`ON DELETE SET NULL`), pinned and historical alike. A
sequence sees what it saw before: the character is uncast. But it rewrites
rows that are otherwise append-only, and history loses who played the
character. Unchanged here; Tom to decide between keeping it, a pointer with
no FK, or refusing the delete while a version names the talent.
