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
character's one cast link. That holds while each character has one. The PR
that lets a second sequence cast a character must give those methods the
sequence first.

## Writes

- **New character** (`characters.create`): one batch inserts the character
  (with the team), its first bible version (with the talent), the cast link,
  the default look, its first look version and the cast look.
- **Bible edit** (`bibleWrite`): appends a version carrying the talent, moves
  the current pointer and the link's pin, and revokes the cast's sheet claims
  when a field the sheets read moved.
- **Recast** (`updateTalent`): a bible version with the new talent, through
  the same writer. The claims are revoked whether or not the talent moved.
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
  that say so go first.

## Legacy columns

`characters.sequence_id`, `character_id`, `talent_id`, `deleted_at` and the
sheet state on `character_looks` are `legacy*` in Drizzle. The SQL names are
unchanged.

- The four on `characters` are **still written** on every create, recast,
  remove and restore. `sequence_id` and `character_id` are NOT NULL, the
  unique index on them is still there, and a worker older than this reads
  all four until the deploy finishes.
- The sheet state on `character_looks` is written only at insert, where NOT
  NULL forces `sheet_status`.
- Nothing reads any of them except `backfillCast`
  (`src/platform/server/db/sequence-cast-backfill.ts`).

Dropping `sequence_id` and `talent_id` is a table rebuild, and
`character_sheet_variants` and `character_voice_versions` cascade from
`characters`. So the drop is its own PR, applied by hand, after this one is
live. `team_id` becomes NOT NULL there too.

## The deploy window

Migrations run before the new worker is live. For that minute the old worker
still writes the old columns.

- **A character or look it creates** has no cast link or cast look. The
  reconcile cron's `sequence_cast.backfill` pass (`backfillCast`, every five
  minutes) gives it one, with the same statements as the migration. Until
  then the character is missing from its sequence. `characters.create` and
  `requireLook` run the same backfill when they meet such a row first.
- **A sheet it lands** on the look's old columns is promoted by the
  `character_looks.claims` pass, which now reads the cast looks.
- **An edit it makes to an existing character** in that minute (a bible
  edit, a remove, a recast) is written to the old columns only and is not
  carried over.

`backfillCast` assumes each character has one link, like the id-only
methods. It goes in the PR that drops the columns.

## Migration

`20261004082223_team_characters_cast` is generated: two `CREATE TABLE`, three
`ADD COLUMN`, indexes. `20261004082252_backfill_team_characters_cast` is
hand-written data SQL. Both run on every automatic path.

- A cast link reuses its character's ULID. A cast look reuses its look's.
- Every pointer, status and in-flight claim is copied as it is. No stored
  digest moves and nothing regenerates.
- The talent goes on the version each character is on. Older versions keep
  null: who played the character then was never recorded.
- A character with no bible version gets one first, as the #1600 backfill
  made them, so `sequence_cast.bibleVersionId` can be NOT NULL.
