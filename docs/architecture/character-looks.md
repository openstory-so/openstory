# Character looks (#2015)

A character can change outfits within a sequence. A **look** is one outfit on
one character: a name ("Office", "Gala gown"), the clothing, and the hair,
makeup or injury notes that change with it (`styling`). Face, body,
personality and voice stay on the character. Each look has its own sheet.
Each scene picks one look per character; a character with no pick wears its
**default look**.

## Data

Same shape as bibles and sheets: an identity row with pointers, append-only
versions, and a claim.

- **`character_looks`** — the look.
  - Identity: `characterId` (FK, `restrict`), `isDefault` (one per character,
    partial unique index), `sortOrder`, `deletedAt`, and
    `selectedLookVersionId` (the live definition).
  - Per-sequence state: `selectedSheetVersionId`,
    `pendingPromoteSheetVersionId` (the sheet claim), `sheetStatus`,
    `sheetError`. **#2017 moves this group onto `sequence_cast_looks`.** Keep
    identity free of anything a sequence decides.
- **`character_look_versions`** — the definition: `name`, `clothing`,
  `styling`, `source` (`backfill` | `analysis` | `edit`). Never rewritten.
- **`character_sheet_variants`** carries `lookId` and `lookVersionId` (the
  look version the run read). The divergent key is (look, model, input hash).
  No FK on `lookId` yet: #2017's hand-applied rebuild adds it.
- **A scene's picks** live in `continuity.characterLooks` on the selected
  `scene_script_versions` row: character tag → look id. Changing one appends
  a script version, like any narrative edit.

**A default look's id is its character's id.** The backfill had to reuse a
ULID (SQL cannot mint one) and every new character keeps the rule. So a sheet
row, a payload or a plan frozen before looks — which name only a character —
name its default look. Look it up through `isDefault`; lean on the id only
for those old shapes (`sheetLookId`, `requireCharacterLook`).

## One source

The look owns clothing and the sheet. The bible's `standard_clothing` and the
character's own sheet status, error, pointer and claim columns are `legacy*`
in Drizzle (the SQL names are unchanged) and nothing writes them. They are
read only for a character an older worker wrote during the deploy, which has
no look row: reads fall back to them, and the first write to that character's
look fills the look in from them (`requireLook`).

"The character's sheet" is its default look's sheet, everywhere. Every scoped
character read returns the character **wearing its default look** under the
old field names (`standardClothing`, `sheetStatus`, `sheetImageUrl`,
`selectedSheetVersionId`, …) plus `lookId`, `lookName`, `styling` and
`looks`. Editing clothing through the character form or `update_character`
writes a look version on the default look.

## Dressing

`src/cast/character-looks.ts` (pure): `wearLook(character, look)` swaps a
look's clothing and sheet onto a character; `dressForScene(characters, picks)`
does it for a scene. A pick is matched by look id alone — the tag it is filed
under is a label, so a rename keeps the pick.

Do not dress by hand. `matchCharactersToShotImage` and `resolveShotReferences`
(`src/shots/scene-matching.ts`) take the scene's `characterLooks` as a
**required** argument and return the cast dressed, so the still, the
reference-only clip, the prompt hashes, the clip's `referenceKeys` and the
stale causes all agree. `loadShotPromptContext` dresses the bible entries a
prompt reads; `narrowShotPromptContext` does the same for a context frozen on
a payload (`wearBibleLooks`, `src/cast/bible-looks.ts`). A bible entry lists
its looks with the one worn **first**, and `standardClothing` is always that
look's clothing.

## Sheets and claims

`CharacterSheetWorkflow` draws one look. The payload snapshots it at the
trigger (`lookId`, `lookVersionId`, `lookName`, `lookStyling`, the clothing as
`characterMetadata.standardClothing`); the run never reads the look.

Claim → demote → guarded promote → fail, on the look
(`characterLooks.claimSheet` / `failSheetClaim`,
`characterSheetVariants.promoteIfPending`):

- A look edit that moves clothing or styling demotes that look's claim in the
  same batch. A rename does not.
- A bible edit to a field the sheets read, a recast and a style change demote
  **every** look's claim.
- The claim is **conditional**: it is taken only while the look version, the
  bible version and the cast talent on the payload are still live. A claim
  that is not taken still returns an id, and the run parks its sheet under it.
- A run that lost its claim parks its sheet as divergent. A failure clears
  only its own claim.
- A payload an older worker froze names no cast talent (or, before #1600, no
  bible version). Absent is "unknown", not "none": `claimSheet` skips that
  part of the condition instead of refusing every cast character.
- The reconcile cron (`reconcileLookSheetClaimsPass`, pass
  `character_looks.claims`) settles the two states no run will: a claim whose
  row already exists as a plain completed sheet is promoted (only a worker
  from before looks leaves that, by landing on the character's legacy columns
  mid-deploy), and a claim older than an hour is failed.

The References stage makes one sheet per look some scene uses: a
`sheet:character` plan unit is a look id — each character's default look
always, any other once a live scene picks it. A look nobody wears gets a
sheet only when someone asks. Talent reuse (`reusesTalentSheet`) is decided
per look, against the talent's default sheet. A recast redraws the default
look and every other look a live scene wears.

Each person look's sheet is its own BytePlus portrait asset (the pool keys by
stored URL). See `byteplus-ark.md` for slot pressure.

## Hashes and staleness

- **Sheet hash**: the clothing keeps the bible's old key
  (`characterBible.standardClothing`), fed from the look; `styling` joins only
  when set, in every digest shape. A backfilled default look therefore hashes
  to the digest its sheet was stamped with.
- **Prompt hashes** read the worn look's clothing, and its styling only when
  set.
- **Still and clip** read the sheet of the look the scene picks.
- Editing a look stales that look's sheet and the shots of the scenes that
  wear it. Switching a scene's look stales that scene's shots only.
- Causes name the look: `Character "Mia" (Gala gown): clothing`.
  A scene that switched a character into another look since the artifact
  adds `look` to that list (next to `Scene: cast and tags`).

## Script analysis

The bibles call lists each character's looks, the default first, as
`{ name, clothing, styling, lines }` — `lines` are gutter lines inside the
scenes that wear the look, because that call knows no scene ids. The shape is
lean on purpose (Anthropic grammar budget, #1035). `bibleFromWire` gives each
look a slug id and builds the picks; `create-cast-records` writes the looks
(`characterLooks.syncFromAnalysis`, matched by **name** so a re-analysis keeps
each look's id, sheet and picks) and analyze-script swaps slugs for row ids
before `persist-scene-looks` writes the picks. Only persisted ids are stored.

- An analysis scene's `sceneId` is not its row's id. `persistSceneLooks`
  finds each row by its position, the way the split does, and
  `scenes.updateContinuity` throws on a row that is not there.
- A `lines` entry outside the script is dropped: the line → scene lookup
  clamps, and a clamped line would dress the wrong scene.
- The default outfit is asked for twice (`standardClothing` and the first
  look); a blank first look keeps `standardClothing`.
- A repeated look name in one response gets a number (`Gala`, `Gala 2`).
- After a re-analysis, a look the script no longer names is soft-removed
  only when nothing is lost: every version of it came from analysis, it has
  no sheet and no scene wears it. A look a person made or edited, one with a
  sheet, and one a scene wears are never touched. A removed look the script
  names again comes back as the same row.
- Voice design sees no outfits (`withoutLooks`); the shot rewrite sees only
  the look worn in that shot's scene (`wornLookOnly`).

## Editing

- Remove is soft and undoable. The default look cannot be removed. A look a
  live scene still picks cannot be removed either: the `ConflictError` names
  the scenes. A scene that already points at a removed look keeps wearing it.
- A scene's picks are set through the scene update as a **per-character
  patch** (`continuity.characterLooks`: a look id sets that character's look,
  `null` puts it back in its default, characters not named keep theirs).
  `applyLookPatch` (`scene-edit.ts`) checks only the ids being set, files
  each pick under its character's own tag, and stores a default look as no
  pick. So a scene that still wears a removed look can have its other picks
  changed.
- Two live looks of one character never share a name.
- A removed look can be read and restored, but not edited, drawn or uploaded
  to (`requireLiveLook`).
- UI: the character panel has a row of looks; picking one shows that look's
  sheet, versions, staleness and divergence. A scene's cast card has a look
  picker. MCP: see `mcp-capability-map.md`.

## Traps

- `continuity.characterLooks` is optional in the type: scenes stored before
  looks have no map, and continuity is read as typed JSON with no parse seam
  to default it at. Missing and `{}` both mean "everyone in their default".
- Scene continuity is compared with `continuityKey` (`scene-narrative.ts`),
  which keys the picks separately: a key-list JSON replacer empties nested
  objects.
- Never read `characters.legacy*` sheet columns or
  `character_bible_versions.legacyStandardClothing` outside the fallbacks.
