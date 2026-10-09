# Team characters (#2017)

A character belongs to the team. A sequence (an episode) never copies one and
never keeps a version of one: it holds a **cast link**, and reads the
character as it is now. A lead who is in 100 episodes is one character, with
one bible, one voice, one set of looks and one sheet per look. An edit from
any episode changes her in every episode; what that edit stales in each one
is staleness's job (`prompt-staleness-dependency-graph.md`), never a
pointer's.

This doc covers the tables, every read and write going through the cast
link, the Characters page, attaching a team character to a sequence and
what analysis does with the attached cast (#2050), and making and editing a
character with no sequence (#2065).

## Data

- **`characters`** — identity: `teamId`, the current bible version
  (`selectedBibleVersionId`), the current voice version
  (`selectedVoiceVersionId`) and its claim, `useVoice`, and `deletedAt`
  (deleted from the team, #2065). Bible versions, looks, sheets and voice
  versions are keyed by the character id.
- **`character_bible_versions`** carries `talentId`: a recast is a new
  version with a different talent, and the cast talent is the current
  version's. It also carries `rendering` (`src/cast/rendering.ts`): what the
  character is rendered as, required unless voice-only (`renderingFor`, in
  every bible writer; a CHECK would need a rebuild). Analysis fills it from
  the sequence style's medium, else its art style (`renderingOfStyle`); a
  hand-added character in a sequence takes the same when the form leaves it
  out; the Characters page requires it. The backfill
  (`20261009063136_backfill_character_rendering`) took the first casting
  sequence's style. It is the only thing a sheet takes from a style.
- **`sequence_cast`** — one row per character per sequence, holding only
  what is the sequence's:
  - `sequenceId`, `characterId`, `scriptCharacterId` (the analysis id, e.g.
    `char_001`; scene character tags resolve through it), `removedAt`,
    `attached`, `createdAt`.
  - `attached` (#2065): the writer picked the character for this sequence
    (`characters.attach`) rather than analysis making it here. Analysis
    never rewrites an attached character.
  - Unique on (`sequenceId`, `characterId`) and on (`sequenceId`,
    `scriptCharacterId`).
  - Soft-remove from a sequence is the link's `removedAt`. The character
    stays.
- **`character_looks`** keeps identity, the current look version
  (`selectedLookVersionId`), and the look's sheet: `selectedSheetVersionId`,
  `pendingPromoteSheetVersionId` (the claim), `sheetStatus`, `sheetError`.
  One sheet per look, whichever sequence drew it. See `character-looks.md`.

Both FKs on `sequence_cast` are `restrict`: deletes are done in app code
(the #612 rebuild trap).

## One read shape

`scopedDb.characters` reads come through the cast link and are scoped to the
team. Each returns the character at its current version plus the link's own
fields, under the names the character's own columns had, so callers did not
change:

| Field                    | Comes from                                 |
| ------------------------ | ------------------------------------------ |
| `sequenceId`             | `sequence_cast.sequenceId`                 |
| `characterId`            | `sequence_cast.scriptCharacterId`          |
| `deletedAt`              | `sequence_cast.removedAt`                  |
| `castId`                 | the link's own id                          |
| `selectedBibleVersionId` | `characters.selectedBibleVersionId`        |
| the bible fields         | that version                               |
| `talentId`               | that version's `talentId`                  |
| `selectedVoiceVersionId` | `characters.selectedVoiceVersionId`        |
| the voice fields         | that version                               |
| `looks`                  | the character's looks, each with its sheet |

A look read (`scopedDb.characterLooks`, and `character.looks`) is the look at
its current version with its sheet. It takes no sequence: the answer is the
same from every sequence and from none.

**A method takes `sequenceId` only when the answer or the write is the
link's.** Reads through the link (`getById`, `getByIds`, `list`,
`listDeleted`, `listWithTalent`), the link's own writes (`softDelete`,
`restore`, `attach`, `create`), and writes that record a sequence event
(`updateBible`, the look writes, `characterSheetVariants.select`,
`selectVersion`) take it. A write made from no sequence (the Characters page,
#2065) passes `null`: the same write, no event. Everything else is the
character's own and takes no sequence: the voice methods, the sheet claim
(`claimSheet`, `failSheetClaim`, `promoteIfPending`), `applyConvergent`, the
sheet lists, `getCurrent`, `listTeam`, `getTeamCharacter`.

A character whose current bible version does not exist throws on read. The
pointer has no FK, so this is the check.

What follows from one character in two sequences:

- **A bible, voice or look edit from one sequence** changes the character.
  The other sequence's sheets, prompts, stills and clips read stale by the
  hashes that already exist, and its own Update redraws them.
- **A look added from one sequence** is the character's: every sequence
  sees it. Look names are unique among the character's live looks.
- **Removing a look** is refused while a scene of any live sequence that
  casts the character wears it. The refusal names the scenes of this
  sequence, or the titles of the others. An archived sequence does not
  refuse: it casts nothing while archived, and a scene that points at a
  removed look keeps wearing it when the sequence comes back.
- **The voice is the character's own and is held until the character is
  deleted (decided 2026-10-09).** A provider voice is held while a
  character's current pointer or a talent names it (`voiceReferences` in
  `characters.ts`, the one list behind `getVoiceReferenceCount` and
  `getOwnVoiceHolds`). Removing a character from a sequence, archiving a
  sequence, or a sequence letting the character go releases nothing.
  Turning the voice off (`setCharacterVoiceEnabled`) and deleting the
  character (`deleteTeamCharacter`) release it, provider first, row second
  (`elevenlabs.md`); a failed release leaves the character listed. Seed
  voices take no slot.
- **Sheet variants are the look's**, with no sequence on the row. A sheet
  parked as divergent by one sequence's run is listed for every sequence
  that casts the character; promoting or discarding it there settles it
  everywhere.

## Characters page

- **`/characters`** is on the sidebar. Its Characters tab lists the team's
  characters, all of them; its Talent tab is the talent library.
  `/talent` redirects to `/characters?tab=talent`; `/talent/$id` is
  unchanged. Signed out, the page opens on the Talent tab (the public
  catalogue) and the Characters tab asks to sign in.
- **The list** is `characters.listTeam`: one grouped read over the cast
  links, with no stored column.
  - Order: the most recently changed sequence casting the character
    (`max(sequences.updated_at)`), then how many sequences cast it.
  - A removed link and an archived sequence do not count.
  - A character nothing casts is listed last (#2065). There is no library
    flag: `characters.in_library` is unread (`legacyInLibrary`) and is
    dropped in a follow-up.
  - The picture is the default look's selected sheet.
  - Not paged: the page and the MCP tool load the whole list (about 1.1 MB
    at 2,500 characters). Known limit. The grid virtualizes its rows.
- **`/characters/$id`** shows the sequences that cast the character and
  embeds the sequence detail view (`CharacterDetailView`) for the one in
  `?sequence=`, or the latest. A character no sequence casts is edited there
  at its current version (`UncastCharacterEditor`): the bible form and the
  looks row, each given `sequenceId: null`, through the team fns
  (`updateTeamCharacterFn`, `createTeamCharacterLookFn`, …,
  `authWithTeamMiddleware`).
- **New character** (#2065) is on the Characters tab. `createTeamCharacterFn`
  → `createTeamCharacter` → `characters.createForTeam`: one batch writes
  the character, its first bible version (`source: 'edit'`, by the user),
  its default look (the character's own id) and that look's first version.
  No cast link and no event (events are per sequence). The consistency tag
  is `char_<name>: <name>`, the tag a hand-added character of that name gets
  in a sequence. The dialog and the cast panel's Add Character share one
  form (`NewCharacterForm`).
- **Shot count** is on that page only. A shot is matched to a character by
  scene tags in memory, one sequence at a time
  (`getTeamCharacterShotCountsFn`).
- **Delete** (`deleteTeamCharacterFn`) is on that page while no sequence,
  archived ones included, casts the character (`TeamCharacter.castAnywhere`,
  the server's own condition). It is soft: `characters.deleted_at` is
  stamped, the character leaves the list, the `@` picker and every other
  team read (`selectTeam`, `attach`, the no-sequence writes), and every row
  of it stays. The toast's Undo clears the stamp (`restoreTeamCharacterFn`).
  - Refused while any sequence, archived ones included, has a link to it
    that is not removed (`getCastInAnySequenceOrArchive`). The write
    (`softDeleteForTeam`) is one UPDATE with the same condition, so a
    sequence that casts the character between the check and the write still
    stops it.
  - A voice it still points at is released first; Undo does not bring it
    back.
  - Restoring it in a sequence that removed it (the existing Restore) clears
    the stamp too, and so does a re-analysis that revives its removed link
    there (`characters.create`).
  - `characters.deleted_at` is not `sequence_cast.removed_at`. A cast read's
    `deletedAt` is still its link's `removedAt`.
- **Every team character** is on the list, in `list_library_characters`
  and in the `@` picker (#2065). The tool keeps its name.

## Attach and `@` references (#2050)

A character is reused only when the writer says so. Analysis never reads the
team's other characters; a character reaches a sequence by an attach, and
the script then names her like any cast member.

- **Nothing is stored in the text.** The script holds her name in capitals,
  as it does for every character; the sequence's cast link says what it is
  bound to. No `@`, no id, no serializer change (the same rule as elements
  and the studio's mention extension, `src/ui/text-editor/mention/`).
- **The attach** is `characters.attach(sequenceId, id)`: one `sequence_cast`
  link. Nothing is copied and nothing is pinned: the sequence reads her
  bible, voice, looks and sheets as they are. Her script id is `char_<name>`
  uniqued against every link of the sequence, removed ones included. The
  link is `attached` (#2065). The event is `character.attached`. Bringing
  back a removed link through the attach sets `attached` too, whatever it
  was: the writer picked her again. (A `restore` from the bin, and an
  analysis revive, leave it.)
- **Refused** unless the sequence is the team's (`NotFoundError`, checked in
  the db method, not only by its callers), and while a live cast member of
  the sequence already has her name (`ConflictError`, `assertNameFree`): the
  text could not tell two ADAs apart. The same check runs before a removed
  link is brought back, by an attach or by Restore. Two characters may still
  share a plain name when analysis made them; nothing refuses that.
  Attaching a character the sequence already casts is idempotent.
- **Surfaces.** The script editor's `@` dropdown lists the team's characters
  not cast here, most recently used first (`libraryMentionItems`, the
  `listTeam` order), as pick-only rows: picking one inserts her name in
  capitals and attaches her (`attachLibraryCharacterFn`); on the create
  screen the pick goes onto the draft (`castCharacterIds`) and
  `createSequences` attaches before the storyboard trigger, so the first
  analysis reads her. A pick-only row never pills: a plain name is prose
  until she is attached. The cast panel's **Add existing character**
  attaches with no script change. API: a string in `create_sequence`'s
  `characters` names a team character first (id or name), then talent. Two
  characters of one name, or a name a character and a talent share, is a
  `CONFLICT` that asks for the id. MCP: `add_character_to_sequence`.
- **Detach** is the existing Remove (soft, the link's `removedAt`).

## Analysis reads the attached cast (#2050)

- **Snapshot.** `triggerStoryboard` freezes the sequence's live cast onto the
  payload (`cast: AttachedCastSnapshot[]`, required on the storyboard,
  analyze-script and scene-split inputs): each as the sequence casts her
  (`characterToBible`, look ids are `character_looks` ids) with `shared` —
  she is not this sequence's to rewrite (`getAnalysisMayNotRewrite`). No
  mid-run read; a payload without the field fails at the top
  (`queuedBeforeCast`).
- **The bibles call** sees a `<CAST>` block shaped like `<ELEMENTS>`
  (`formatCastBlock`): script id, name, appearance, look names. It echoes
  the ids and look names of the characters the script uses, adds a look only
  when none fits, and makes a new character for any name it cannot place.
  With nobody cast the block is absent and the message is byte-for-byte what
  it was, so the recorded `script-bibles` fixture replays.
- **A shared character is linked, never edited.** `applyAttachedCast`
  replaces her entry with the snapshot (her bible wins over anything the
  model wrote), keeps her looks by id, appends the looks the model named
  that she lacks, and re-points scene picks from a slug to the look it named.
  `create-cast-records` skips `characters.create` for her (no bible version)
  and calls `characterLooks.linkFromAnalysis`: a look matched by id or by
  name among her live looks is hers already; a name she lacks becomes a new
  look; nothing rewritten, nothing removed. She is left out of talent
  matching: her talent is on her bible version.
- **A character analysis made here, that only this sequence has ever cast,**
  is re-analysed as before: bible rewritten, looks synced by name, unused
  analysis-made looks retired.
- **The db layer decides, every time.** `shared` on the payload only shapes
  the prompt. `characters.create` and `characterLooks.syncFromAnalysis` ask
  `analysisMayNotRewrite` (`sequence-cast.ts`, the one place the rule
  lives) on every call. It is true when this sequence's link is `attached`,
  or when any other sequence has a link to her, removed or archived
  included. So a character made on the Characters page and attached to one
  sequence is safe (#2065), and so is one attached here from a sequence
  since archived. A held character's live link is returned as it is and her
  looks are linked (`linkFromAnalysis`); her **removed** link is left
  removed, and an entry that reused its script id becomes a new character
  under the next free id (`char_001_2`).
- **The model must echo the cast.** Before anything is written, scene-split
  checks the reply against the block (`castEchoProblem`): an entry that
  carries a cast id with another name, or a cast character's name under a
  new id, fails the run with a plain message ("Run it again"). The prompt
  says a script character with a cast character's name IS that character.
- **Plain names, where two characters share one.** Analysis may make two
  "Sarah"s, and a hand-made one may sit beside an analysed one. Look picks
  are keyed on the character's tag (a NEW entry whose tag is in use gets a
  number, `sarah_2`); dialogue speakers are matched by text, so
  `matchSpeaker` refuses two whole-name matches (`ConflictError`, "Rename
  one so dialogue knows who speaks"); scene tags (`reconcileSceneTags`) tag
  both wherever the name appears. A known limit until a scene tag can name
  the cast link; rename one of them.
- **Save as talent** is what Add to Library did before #2017: it copies the
  character into a new talent (`saveCharacterAsTalentFn`). It is how a
  character reaches the recast picker, the new-sequence talent picker and
  the studio today. Hidden for a talent-cast or voice-only character.
- **A character the page cannot list** (another team's, deleted, or gone)
  reads "Character not found" with a way back, not an error.
- MCP: `list_library_characters`.

## Writes

- **New character** (`characters.create`): one batch inserts the character
  (with the team), its first bible version (with the talent), the cast link,
  the default look and its first look version.
- **New character with no sequence** (`characters.createForTeam`, #2065):
  the same batch without the cast link.
- **Bible edit** (`bibleWrite`): appends a version carrying the talent, moves
  the current pointer, and revokes the character's sheet claims when a field
  the sheets read moved. The same from no sequence, with no event.
- **Recast** (`updateBible` with `source: 'recast'` and the `talentId`): ONE
  bible version, by the person who recast, carrying the new talent and the
  appearance copied from it. The claims are revoked whether or not the
  talent moved. `bibleWrite` takes the talent as a required argument, so
  every writer says who plays the character. The recast run redraws the
  default look's sheet and the launching sequence's shots; every other
  sequence reads the new version and redraws from its own Update.
- **Look edit** (`lookDefinitionWrite`): appends a look version and moves
  the look's current pointer, revoking the look's sheet claim when clothing
  or styling moved.
- **Remove / restore**: the link's `removedAt`.
- **Sheet claim, promote, fail, pick**: on the look. See
  `character-looks.md` § Sheets and claims.
- **Talent changes** revoke the claims of the characters whose current bible
  version names that talent (`castOfTalent`).
- **Deleting a sequence** removes its cast links, then only the characters
  no other sequence ever cast and the writer did not attach
  (`charactersOnlyIn`): an attached character is the team's. No app path
  hard-deletes a sequence today. The ids are read before the batch, because
  the links that say so go first. See § Hard deletes.

## Hard deletes

Nothing cascades from a sequence to a character, or from a character to its
rows. Every foreign key into `characters` is `no action` or `restrict`, so a
delete that forgets a child fails instead of taking rows with it.

- `deleteCharactersStatements(db, where)` (`src/cast/server/db/characters.ts`)
  is the one list of what a character owns: bible versions, look versions,
  looks, sheet variants, voice versions, then the character. The cast links
  go before it (`deleteCastStatements`).
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
- Deleting a team is refused while it has characters (`characters.team_id`,
  no action).

## Migrations

**Expand** (PR #2022, on main). `20261004082223_team_characters_cast` is
generated: `sequence_cast` and `sequence_cast_looks`, three `ADD COLUMN`,
indexes. `20261004082252_backfill_team_characters_cast` is hand-written data
SQL: a cast link reuses its character's ULID, a cast look its look's.

**Contract** (the legacy column drop, on main):
`20261006232126_loosen_character_children` and
`20261006232156_drop_character_legacy_columns` rebuilt `characters` without
its four cast columns, with the guard-and-defer pattern described in
`AGENTS.md` § D1 table-rebuild trap. Proven on local D1, a copy of
production, an empty remote D1 and a throwaway remote D1 loaded with a
production export (2026-10-07).

**Unpin** (this PR). Three files, in order:

1. `20261008052037_character_deleted_at` and `20261008052530_cast_attached`
   — generated, one `ADD COLUMN` each.
2. `20261009054608_look_sheets_from_cast_looks` — hand-written data SQL. A
   look's sheet pointer, claim, status and error go back onto
   `character_looks` from its cast looks: where two sequences selected
   different sheets of one look, the most recently updated cast look wins,
   a cast look that selected a sheet winning over one that did not.
3. `20261009054728_unpin_sequence_cast` — generated: `DROP TABLE
sequence_cast_looks` and a native `ALTER TABLE sequence_cast DROP COLUMN
bible_version_id`. No rebuild, so the #612 trap does not apply.

The deploy window: the previous worker writes `sequence_cast_looks` until
the swap. A sheet it lands on a cast look after file 2 ran is lost to the
look's pointer (the reconcile cron promotes a landed claim on
`character_looks`, not a cast look), and reads stale once the new worker
serves: one redraw, never a wrong sheet. A write it makes after file 3 fails
on the missing table, in one batch, so nothing is half written.

## Open question

Deleting a talent sets `character_bible_versions.talent_id` to null on every
version that named it (`ON DELETE SET NULL`), current and historical alike.
It rewrites rows that are otherwise append-only, and history loses who
played the character. Unchanged here; Tom to decide between keeping it, a
pointer with no FK, or refusing the delete while a version names the talent.
