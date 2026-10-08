# Team characters (#2017)

A character belongs to the team. A sequence (an episode) never copies one: it
holds a **cast link** that pins the version of the character it uses. A lead
who is in 100 episodes is one character, with one set of looks.

This doc covers the tables, the backfill, every read and write going through
the cast link, the Characters page, attaching a team character to a
sequence and what analysis does with the attached cast
(#2050), making and editing a character with no sequence (#2065), and moving
a sequence to a newer version, the one-off copy and a recast applied to a
range of sequences (§ Version moves).

## Data

- **`characters`** — identity: `teamId`, the **current** bible
  version (`selectedBibleVersionId`, the one a new sequence adopts) and the
  voice. Bible versions, looks, sheets and voice versions stay keyed by the
  character id.
- **`character_bible_versions`** gains `talentId`. A recast is a new version
  with a different talent; the cast talent is the pinned version's.
- **`sequence_cast`** — one row per character per sequence.
  - `sequenceId`, `characterId`, `scriptCharacterId` (the analysis id, e.g.
    `char_001`), `bibleVersionId` (the pin), `voiceVersionId` (the voice
    pin; null when the character has no voice here), `removedAt`,
    `attached`, `createdAt`.
  - `attached` (#2065): the writer picked the character for this sequence
    (`characters.attach`) rather than analysis making it here. Analysis
    never rewrites an attached character. False on every link made before
    the column, which is right: those were covered by "another sequence has
    cast it".
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
- The team reads: `listTeam`, `getTeamCharacter` (§ Characters page), and
  `getCurrent`: the bible and looks at their current versions.
- A look's definition history (`listVersions`) and a sheet variant by id.

**A write made from no sequence passes `null` (#2065).** The sequence stays
a required first argument; `null` says "from the Characters page", as
`updateVoice(null, …)` already did. It appends the version and moves the
CURRENT pointer only. No pin moves and no sequence event is written.

- `characters.updateBible(null, id, …)`: `source: 'edit'` only, no voice
  description (the voice is pinned per sequence), returns the character at
  its current version.
- `characterLooks.create / update / remove / restore(null, …)`. A name is
  unique among all the character's live looks. `remove` checks the scenes
  of every live sequence that uses the look.
- No sheet, voice, recast or version-select write takes `null`: those are a
  sequence's.
- A deleted character (`characters.deleted_at`) is not found by
  `getCurrent` or by any of these writes until it is restored.
- A sequence that casts the character keeps the version it pinned and reads
  "Not the current version" (§ Version moves).

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
  is the one write made from no sequence (deleting a character nothing
  casts): only the current pointer moves. Attach pins the
  current voice version. `useVoice` stays on the character.
- **A provider voice is held while anything names it** (`voiceReferences`
  in `characters.ts`, the one list behind `getVoiceReferenceCount` and
  `getOwnVoiceHolds`): a live cast link's pin — not removed, in a sequence
  that is not archived — a character's current pointer, or a talent. So a
  recast or voice change from sequence 50 leaves sequences 1–49 recording in
  the old voice, and that voice is released only when the last of them
  moves on. `releaseCharacterVoice(scopedDb, character, sequenceId, …)`
  counts its own references first (the current pointer and that sequence's
  pin, where they name the voice) and passes them as `heldBy`, so the
  provider delete still comes before the row write and another sequence's
  pin still blocks it.
- **The voice goes when no live sequence casts the character.** "Cast" has
  one meaning (`castElsewhere` in `characters.ts`): a cast link that is not
  removed, in a sequence that is not archived. The list and the character
  page count a sequence the same way. The character itself stays in the
  team (#2065); its voice history stays, and it gets a voice again when it
  is next cast.
  - Removing a character from a sequence, or archiving the sequence,
    releases the saved voice unless another live sequence casts the
    character (`characters.getHeldElsewhere`).
  - Deleting a character releases the voice first (`deleteTeamCharacter` in
    `cast-edit.ts`). Provider first, row second (`elevenlabs.md`); a failed
    release leaves the character listed.
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
  - The picture is the default look's sheet as the latest sequence that has
    one selected it.
  - Not paged: the page and the MCP tool load the whole list (about 1.1 MB
    at 2,500 characters). Known limit. The grid virtualizes its rows.
- **`/characters/$id`** shows the sequences that cast the character and
  embeds the sequence detail view (`CharacterDetailView`) for the one in
  `?sequence=`, or the latest. Looks, sheets and edits there are that
  sequence's.
- **A character no sequence casts** (#2065) is edited there at its current
  version (`UncastCharacterEditor`): the bible form and the looks row the
  sequence view uses, each given `sequenceId: null`. The writes are the
  team fns (`updateTeamCharacterFn`, `createTeamCharacterLookFn`, …,
  `authWithTeamMiddleware`). Sheets, voice, recast and upload are not
  offered: "Sheets and voice need a sequence." (a sheet depends on the
  sequence's style and image model). Once a sequence casts it, the page is
  the sequence view again.
- **New character** (#2065) is on the Characters tab. `createTeamCharacterFn`
  → `createTeamCharacter` → `characters.createForTeam`: one batch writes
  the character, its first bible version (`source: 'edit'`, by the user),
  its default look (the character's own id) and that look's first version.
  No cast link, no sheet, no voice, no event (events are per sequence). The
  consistency tag is `char_<name>: <name>`, the tag a hand-added character
  of that name gets in a sequence. The dialog and the cast panel's Add
  Character share one form (`NewCharacterForm`).
- **Shot count** is on that page only. A shot is matched to a character by
  scene tags in memory, one sequence at a time
  (`getTeamCharacterShotCountsFn`).
- **Delete** (`deleteTeamCharacterFn`) is on that page while no sequence,
  archived ones included, casts the character (`TeamCharacter.castAnywhere`,
  the server's own condition). It is soft: `characters.deleted_at` is
  stamped, the character leaves the list, the `@` picker and every other
  team read (`selectTeam`, `attach`), and every row of it stays. The toast's
  Undo clears the stamp (`restoreTeamCharacterFn`).
  - Refused while any sequence, archived ones included, has a link to it
    that is not removed (`getCastInAnySequenceOrArchive`): that sequence
    would cast a character the team no longer lists. The write
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
  link pinning her **current** bible version, and one cast look per live look
  she has, each pinned at its current version and sheet-less (a sheet depends
  on the sequence's style and image model, so the first run draws them). Her
  script id is `char_<name>` uniqued against every link of the sequence,
  removed ones included. The link is `attached` (#2065). The event is
  `character.attached`. Nothing is copied. Bringing back a removed link
  through the attach sets `attached` too, whatever it was: the writer picked
  her again. (A `restore` from the bin, and an analysis revive, leave it.)
- **Refused** unless the
  sequence is the team's (`NotFoundError`, checked in the db method, not
  only by its callers), and while a live cast member of the sequence already
  has her name (`ConflictError`, `assertNameFree`): the text could not tell
  two ADAs apart. A script-created SARAH already cast plus an attach of
  another Sarah is refused with that message; nothing renames or picks one.
  The same check runs before a removed link is brought back, by an attach or
  by Restore. Two characters may still share a plain name when analysis made
  them; nothing refuses that. Attaching a character the sequence already
  casts is idempotent.
- **Surfaces.** The script editor's `@` dropdown lists the team's characters
  not cast here, most recently used first (`libraryMentionItems`, the
  `listTeam` order), as pick-only rows: picking one inserts her name in
  capitals and attaches her (`attachLibraryCharacterFn`); on the create
  screen the pick goes onto the draft (`castCharacterIds`) and
  `createSequences` attaches before the storyboard trigger, so the first
  analysis reads her. A pick-only row never pills: a plain name is prose until
  she is attached. The cast panel's **Add existing character** attaches with
  no script change. API: a string in `create_sequence`'s `characters` names
  a team character first (id or name), then talent. Two characters of one
  name, or a name a character and a talent share, is a `CONFLICT` that asks
  for the id: every character can be named now, one-offs included, so a
  name is never guessed at. MCP: `add_character_to_sequence`.
- **Detach** is the existing Remove (soft, the link's `removedAt`).
- **A rename** in a later version leaves the script saying the old name until
  the sequence moves version (version moves, a later PR).

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
  replaces her entry with the snapshot (the pinned bible wins over anything
  the model wrote), keeps her looks by id, appends the looks the model named
  that she lacks, and re-points scene picks from a slug to the look it named.
  `create-cast-records` skips `characters.create` for her (no bible version)
  and calls `characterLooks.linkFromAnalysis`: a cast look where this
  sequence lacks one (pinned at the look's current version), matched by id or
  by name among every live look she has, cast here or not; a new look for a
  name she lacks; nothing rewritten, nothing removed. She is left out of
  talent matching: her talent is on the pinned version.
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
  since archived. A held character's live link is returned as it
  is and her looks are linked (`linkFromAnalysis`); her **removed** link is
  left removed, and an entry that reused its script id becomes a new
  character under the next free id (`char_001_2`). So a character attached
  elsewhere between the click and the write is
  still safe, and so is one the model reached through a link the snapshot
  did not list.
- **The model must echo the cast.** Before anything is written, scene-split
  checks the reply against the block (`castEchoProblem`): an entry that
  carries a cast id with another name, or a cast character's name under a
  new id, fails the run with a plain message ("Run it again"). The prompt
  says a script character with a cast character's name IS that character.
- **Plain names, where two characters share one.** Analysis may make two
  "Sarah"s, and a hand-made one may sit beside an analysed one. What is
  keyed on the character and what is not:
  - Look picks: keyed on the character's tag. An entry that echoes a cast
    id keeps that character's own tag (so a re-analysis moves nothing of
    hers); a NEW entry whose tag is in use gets a number (`sarah`,
    `sarah_2`), so two characters' picks never overwrite each other.
  - Dialogue speakers: a line names a speaker by text and has no id, so
    `matchSpeaker` refuses two whole-name matches (`ConflictError`, "Rename
    one so dialogue knows who speaks") rather than taking the first. The
    generation plan and dialogue audio surface it.
  - Scene tags: `reconcileSceneTags` scans each scene's text for the name,
    so both characters are tagged wherever the name appears, and both
    sheets reach those shots. A known limit until a scene tag can name the
    cast link; rename one of them.
- **Save as talent** is what Add to Library did before #2017: it copies the
  character, as one sequence casts it, into a new talent
  (`saveCharacterAsTalentFn`). It is how a character reaches the recast
  picker, the new-sequence talent picker and the studio today. It stays
  until #2018 defines what a talent is. Hidden for a talent-cast or
  voice-only character, as the old button was.
- **A character the page cannot list** (another team's, deleted, or gone) reads "Character not found" with a way
  back, not an error.
- MCP: `list_library_characters`.

## Writes

- **New character** (`characters.create`): one batch inserts the character
  (with the team), its first bible version (with the talent), the cast link,
  the default look, its first look version and the cast look.
- **New character with no sequence** (`characters.createForTeam`, #2065):
  the same batch without the cast link and the cast look.
- **Bible edit** (`bibleWrite`): appends a version carrying the talent, moves
  the current pointer and the link's pin, and revokes the cast's sheet claims
  when a field the sheets read moved. From no sequence (`castId` null) only
  the version and the current pointer are written.
- **Recast** (`updateBible` with `source: 'recast'` and the `talentId`): ONE
  bible version, by the person who recast, carrying the new talent and the
  appearance copied from it. The claims are revoked whether or not the
  talent moved. `bibleWrite` takes the talent as a required argument, so
  every writer says who plays the character.
- **Look edit** (`lookDefinitionWrite`): appends a look version, moves the
  look's current pointer and the cast look's pin. From no sequence
  (`castLookId` null) no pin is written.
- **Remove / restore**: the link's `removedAt`.
- **Sheet claim, promote, fail, pick**: on the cast look. See
  `character-looks.md` § Sheets and claims; only the row changed.
- **Talent changes** revoke the claims of the cast links whose pinned bible
  version names that talent (`castOfTalent`).
- **Deleting a sequence** removes its cast looks and links, then only the
  characters no other sequence ever cast and the writer did not attach
  (`charactersOnlyIn`): an attached character is the team's. No app path
  hard-deletes a sequence today; when one does, decide first whether those
  characters should stay in the team instead. The ids are read before the batch, because the links
  that say so go first. See § Hard deletes.

## Version moves (PR 3)

A sequence that pins a bible, voice or look version other than the current
one, or lacks a cast look for a live look, is **behind**. Nothing moves it
but a person.

- **"Not the current version"** shows on the character panel (a status line
  with "Update this sequence" and "Move other sequences…") and as a badge on
  the cast rail card, computed off the cast read (`isBehindCurrentVersion`,
  `src/cast/version-behind.ts`: pinned ≠ current). The server's
  `characters.listCastOfCharacter` says the same and also counts a missing
  cast look (`looksToAdd`). The wording is true whichever way the versions
  differ: `selectVersion` on a look can leave a pin on a later version than
  the current one. "Move sequences" is on the panel only when another live
  sequence casts the character or this one is behind
  (`useCharacterCastElsewhere`).
- **Every move goes through `src/cast/server/version-moves.ts`**:
  `moveSequenceToCurrent` (one sequence: "Update this sequence", the MCP
  `update_cast_to_current`) and `moveCastsToCurrent` (many: "Move
  sequences", `move_character_casts`, a range recast). The db write is
  `characters.moveCastToCurrent(sequenceId, id)`: one batch that points the
  link at the current bible and voice versions (guarded on both pins the
  read saw), every cast look at its look's current version, inserts a cast
  look for each live look the sequence lacked (sheet-less), revokes the
  cast's sheet claims (a pin move changes their inputs under any run in
  flight) and writes `character.version-moved` with every from → to. No
  version row is written and no current pointer moves. Nothing when nothing
  is behind. After the write, the voice the pin let go of is released
  through `releaseReplacedVoice` when nothing holds it any more (the last
  pin moving off a voice is what frees its slot; provider first, row second,
  a failed release logged and retried by a later release).
- **Many sequences are checked first** (`assertMovableSequences`): every id
  must be the team's (`sequences.getById`, the check
  `sequenceAccessMiddleware` / `productionAccess` make) and cast the
  character through a live link; one id outside that set is `NotFoundError`
  for the whole call before any write, never a partial move. A range recast
  runs the same check before the recast writes anything.
- **Move sequences** (`MoveSequencesDialog`, `previewVersionMove`) lists the
  live sequences casting the character; each behind one shows what moves
  (bible fields, talent, voice, a look's clothing or styling, looks added),
  the shots wearing the character and an **upper-bound** cost: a sheet for
  every look whose inputs move (every look when a sheet field of the bible
  or the talent moves, a pointer-less legacy sheet included) and every look
  the move adds, a still per shot, a clip per shot at the video model's
  longest length, and a dialogue re-record per shot when the voice moves,
  priced with the sequence's models. Ticked rows move in ONE batch
  (`characters.moveCastsToCurrent`): a failure part-way moves none, never
  two of five. The move starts no run: each moved sequence reads stale by the hashes that
  already exist, and its own "Inputs changed" banner and Update all give the
  exact plan and price. One click never launches fifty renders.
- **The version strip is the sequence's.** `character_sheet_variants.
castLookId` names the cast look a sheet was drawn or uploaded for
  (stamped in `landCharacterSheet` and `applyConvergent`; the backfill
  filled it where the look had one cast look). `listHistoryByLook(sequenceId,
lookId)` lists the sheets that sequence made or has selected, and
  `listDivergentActiveByCharacter(s)(sequenceId, …)` only the alternates its
  own runs parked. A row with `castLookId` null (unknown origin) is listed
  everywhere, as every row was before. One nullable column; no sheet row
  was copied.
- **Causes read the pin, not the clock**: see
  `prompt-staleness-dependency-graph.md` § 3 and `src/shots/pin-moves.ts`.
- **Recast across a range.** A recast (`recastCharacter`) is still ONE new
  bible version carrying the talent, and one new voice version where the
  talent has a voice, both pinned by the sequence it was launched from; the
  `RecastCharacterWorkflow` regenerates that sequence's default-look shots
  as before. `applyToSequenceIds` (the confirm dialog's "Also apply to"
  checklist, the MCP tool's input) names the other sequences to move to it:
  each is `moveCastToCurrent` — pins moved, sheet claims revoked, nothing
  generated — and then reads stale, with the old sheet still selected, until
  its own Update redraws its sheets and shots. A sequence not named keeps the
  old face and voice (the old voice is held by its pin) and shows "Not the
  current version". The result and `recast_character` report
  `movedSequences` (`moved: false` for one already current) and
  `sequencesLeftBehind`.
- **Make a one-off copy** (`characters.copyForSequence(sequenceId, id)`,
  offered while another live sequence casts the character): a NEW team character from the version
  this sequence pins, and this sequence's link repointed at it, in one
  batch. The repointed link is `attached` (#2065): a copy is the writer's
  deliberate character, so analysis never rewrites it. The copy **owns** its
  row, one bible version
  (the pinned bible, with its talent), one voice version naming the same
  provider voice id (held by both until the last lets go), and one look row
  per live look (the default's id is the copy's id) with one version each;
  the sequence's cast looks are repointed at them. The copy **shares** the
  original's sheet rows: `selectedSheetVersionId` stays, because stills and
  clips key on the sheet version id, so a copy that redrew its sheets would
  stale every shot. Those rows carry the cast look's id, so the copy's strip
  lists them (`listHistoryByLook`), the copy can re-select them
  (`characterSheetVariants.select` resolves a sheet of another look through
  `castLookId`), and nobody can discard a sheet a cast look selects (both
  "is it live" checks are in `discard`'s UPDATE WHERE, so a select landing
  between a check and the write cannot discard a just-selected sheet). New
  sheets land under the copy's looks. Scene picks name look ids, so every
  scene of the sequence picking a non-default look gets a script version
  naming the copy's look, in the same batch (`scenes.
updateContinuityStatements`): a part-way failure leaves no scene pointing
  at a look the cast does not have. The script id stays, so scene tags match
  and no prompt hash moves. Two more things keep the copy free:
  - **Clips.** A clip's `referenceKeys` stamp `character:<id>:<sheet>` with
    the ORIGINAL's id. The copy records `characters.copiedFromCharacterId`,
    and the live reference identity and the "would be sent now" set answer
    for that id too (`characterReferenceEntityKeys`, `src/motion/
reference-provenance.ts`), so a clip stamped before the copy stays
    fresh, and a sheet re-selected on the copy still stales it. Only the
    immediate original is aliased: a copy of a copy answers for the copy it
    was made from, not the first original, so a clip stamped before the
    first copy reads stale after a second copy in the same sequence. Rare,
    and visible as an ordinary "Inputs changed", not silent.
  - **A pre-#1419 default sheet** (the row keyed to the original's id, no
    pointer) would be lost, since the copy's default look is keyed to the
    copy's id. That one row is carried across under the copy's id, same
    image and hash, pointer still null, so the still's sheet ingredient
    (`selectedSheetVersionId ?? sheetInputHash`) and the clip's key (the
    url) do not move. One copied row, for that legacy case only.
    Refused while a sheet run holds a claim here, and refused when nothing
    else casts the original: there is nothing to protect from this
    sequence's edits — "only in this sequence; edit it directly". Event `character.copied`.

## Sheet reuse by hash (PR 4)

An episode that owes a look's sheet points at a finished one instead of
drawing it, when one exists with the same inputs. Decided at the plan,
landed by id in the run, counted at zero in both places the copied talent
sheet is. The rules, what the hash covers, and why the row is shared rather
than copied: `character-looks.md` § Sheets and claims, "Sheet reuse by
hash". The one row referenced by two cast looks is the same shape a one-off
copy already uses (above), so the strip, the discard guard and
`characterSheetVariants.select` needed nothing new.

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
  - A character another sequence casts is not removed,
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

**The attach flag** (#2065). `20261008052530_cast_attached` is
generated and unedited: one `ALTER TABLE sequence_cast ADD attached integer
DEFAULT false NOT NULL`. No rebuild. The previous worker does not name the
column, so its inserts take the default: an attach it makes in the deploy
window is not flagged, and is covered only by the "another sequence has cast
it" half of the rule, as before.

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
