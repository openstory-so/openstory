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
    `selectedLookVersionId` (the look's current definition).
  - The sheet: `selectedSheetVersionId`, `pendingPromoteSheetVersionId` (the
    sheet claim), `sheetStatus`, `sheetError`. One sheet per look, shared by
    every sequence that casts the character (#2017, `team-characters.md`).
- **`character_look_versions`** — the definition: `name`, `clothing`,
  `styling`, `source` (`backfill` | `analysis` | `edit`). Never rewritten.
- **`character_sheet_variants`** carries `lookId` and `lookVersionId` (the
  look version the run read). The divergent key is (look, model, input
  hash). No FK on `lookId`: adding one to an existing table is a rebuild,
  and no migration has done it.
- **A scene's picks** live in `continuity.characterLooks` on the selected
  `scene_script_versions` row: character tag → look id. Changing one appends
  a script version, like any narrative edit.

**A default look's id is its character's id.** The backfill had to reuse a
ULID (SQL cannot mint one) and every new character keeps the rule. So a sheet
row stored before looks — which names only a character — names its default
look. Look it up through `isDefault`; lean on the id only for those stored
rows (`requireCharacterLook`).

**A run from before looks is failed, not patched.** A payload queued, a plan
frozen or a step result cached before #2015 names no look. Each workflow that
can receive one checks once, at the top (`assertQueuedWithLooks` /
`queuedBeforeLooks` in `sheet-snapshots.ts`), and fails with "Queued before
character looks shipped. Run it again." No field is defaulted further down.
The sheet and recast runs clear the claim their trigger took by the claim's
own id (`characterLooks.failSheetClaimByVersion`), never by a guessed look.

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

## The default look owns the features (#2065)

The character form has no clothing field and no distinguishing-features
field. Clothing was already the default look's. What the bible called
distinguishing features is the default look's `styling` ("Hair, makeup,
injuries"). No other look inherits it.

**Lazy move, no data migration.** `character_bible_versions.distinguishing_features`
is `legacyDistinguishingFeatures` in Drizzle (the SQL name is unchanged), so
a stray reader does not compile.

- **Read: one resolver.** `effectiveStyling(styling, legacyFeatures)`
  (`src/cast/character-looks.ts`). A default look's styling is its own joined
  with the legacy text of the character's current bible version: blank
  parts skipped,
  a newline between, and the features not repeated when the styling already
  holds them. Any other look's styling is its own. The look reads
  (`selectLooks`) resolve it, so every `styling` a
  caller sees is the effective one: the editor, the prompts, the payloads,
  the current digests. A look also carries `storedStyling`, the version's own
  column, and a character `legacyDistinguishingFeatures`. Those two are for
  the legacy digests (`legacyStylingParts`), a write that copies a version
  forward, and the deprecated API field. Nothing else reads them.
- **Write: `lookDefinitionWrite`.** It diffs the patch against the effective
  styling, so a save of what the field showed writes nothing. When the
  styling itself is edited on a default look, the look version takes the
  submitted text and, in the same batch, a bible version with the legacy
  text null is appended and made current (`legacyFeaturesMove`), with every
  sheet claim of the character revoked and, from a sequence, a
  `character.updated` event recording the move. That is the move, done once. A rename or a
  clothing edit writes the look's own stored styling to the new version and
  leaves the bible alone, so it stales nothing the old code did not.
- **Carried while it is still on the bible.** `bibleWrite` takes the
  legacy text of the version it reads from as a required field and writes
  it to the next one: an age edit, a recast and a re-analysis all keep it.
  But only while the character's CURRENT version still holds it. Once the
  move has nulled it, every new version has null, decided inside the
  insert, so a write that read an older version cannot bring back a mark
  its writer removed. New characters never have it.
  `effectiveStyling` treats the text as already held only when the styling
  is the text or ends with the `\n<text>` the resolver writes; a substring
  ("red scarf" and "scar") is not held.
- **Digests.** The current sheet and prompt digests hash the effective
  styling and have no features key. Verify also accepts `pre-2065`, the same
  body with the features under their own key and the look's own styling,
  built from the stored parts, through the existing legacy-kind lists and
  `LEGACY_HASH_UNTIL`. The verify functions take the stored parts as a
  required argument. `pre-2065` reads the spec and the voice-only flag as
  the current shape does, so it is accepted whatever else moved.
- **What goes stale.** Nothing on deploy. The first edit of the default
  look's styling stales its sheet and the shots that wear it, like any
  styling edit. It also stales the sheets and prompts of the character's
  other looks that were stamped before #2065: they were stamped with the
  features, which are gone from the bible. Those drawn from the default
  sheet were going to be redrawn with it anyway.
- **Payloads and recordings.** A bible entry has no `distinguishingFeatures`.
  One written before #2065 is folded at a seam (`foldLegacyFeatures`,
  `src/cast/bible-looks.ts`): every workflow payload once, in the workflow
  base (`foldLegacyFeaturesInPayload`), and the bibles response in its wire
  schema, so a recorded fixture still parses. The entry's default look takes the text. Under slug ids it
  is the `default` slug wherever it sits, and an entry with no default look
  (only the worn look frozen) drops the text for that run. Under persisted
  ids an entry does not say which look is the default (it carries the script
  id, not the row id the default look shares), so the first look takes it:
  the worn one, on a prompt payload dressed for a scene that picks another
  look, as that queued prompt would have read it. A sheet payload keeps its
  look's styling beside the entry: the features join `lookStyling` on the
  default look (`face` null), and the pair as queued rides along as
  `queuedLegacyStyling` for the run's check of its own snapshot hash. A step
  result cached before the deploy is not folded: a run that resumes across
  it reads the entry without the text.
- **Sheet prompt.** One styling section. Its heading is the one the old
  section had ("Distinguishing Features:", or "Makeup & Styling…" when cast;
  "Hair, Makeup & Condition for this look:" on a look drawn from the default
  sheet), because the recorded e2e image fixtures match on the whole prompt.
- **Analysis.** The bibles call is not asked for the field. A permanent mark
  (a scar, a birthmark, a tattoo) goes in `physicalDescription`; hair,
  makeup, jewelry, accessories, injuries and dirt go in the look's styling.
  The user message is unchanged: the recorded bibles fixture matches on it.
- **API and MCP.** Inputs still take `standardClothing` (the default look's
  clothing) and `distinguishingFeatures` (appended to the default look's
  styling unless already there; blank is ignored), in `cast-edit.ts`.
  Outputs still carry both, derived and marked deprecated:
  `distinguishingFeatures` is the legacy text not yet moved, else null.
- **A talent's sheet metadata** keeps its own `distinguishingFeatures`
  (`TalentSheetMetadata`). It describes the talent, not a character.
- **Later.** After `LEGACY_HASH_UNTIL`: backfill the remaining legacy text
  into the default looks, delete the `pre-2065` shape and the fold seams,
  and drop the column (a native `DROP COLUMN`).

Edges, known and left: a look's version history lists each version's own
styling, so a default look not yet edited shows less there than in the
editor. A character an older worker wrote before #1600 has no bible version
to append to, so its legacy text stays joined.

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
trigger (`lookId`, `lookVersionId`, `lookStyling`, the clothing as
`characterMetadata.standardClothing`); the run never reads the look.

Claim → demote → guarded promote → fail, on the look
(`characterLooks.claimSheet` / `failSheetClaim`,
`characterSheetVariants.promoteIfPending`):

- A look edit that moves clothing or styling demotes that look's claim in the
  same batch. A rename does not.
- A bible edit to a field the sheets read, a recast and a style change demote
  **every** look's claim.
- The claim is **conditional**: it is taken only while the look's current
  version, the character's current bible version, and that bible version's
  talent are still the ones on the payload. A claim that is not taken still
  returns an id, and the run parks its sheet under it.
- A run that lost its claim parks its sheet as divergent. A failure clears
  only its own claim.
- A payload frozen before #1600 names no bible version. Absent is "unknown",
  not "none": `claimSheet` skips that part of the condition.
- The reconcile cron (`reconcileLookSheetClaimsPass`, pass
  `character_looks.claims`) settles the two states no
  run will: a claim whose row already exists as a plain completed sheet is
  promoted (only an older worker leaves that, by landing on the legacy
  columns mid-deploy), and a claim older than an hour is failed.

The References stage makes one sheet per look some scene uses: a
`sheet:character` plan unit is a look id — each character's default look
always, any other once a live scene picks it. A look nobody wears gets a
sheet only when someone asks. A look other than the
default is drawn from the default look's sheet: the run draws the person
from that image and changes the costume, and the talent image is not also
sent. Talent reuse (`reusesTalentSheet`) applies only to the default look,
against the talent's default sheet.

- **The face** is the default look's selected sheet, whatever its last
  attempt did (`populatedDefaultSheet`). A failed or running re-roll leaves
  that sheet selected and on screen, and it is still the face. The plan,
  the trigger, the upload and the panel all ask this one question.
- **The payload** carries `face: { url, versionId } | null`, required; null
  exactly when the look is the default. The trigger refuses a non-default
  look with no face (`buildRegenerateCharacterSheetPayload`), so no path
  draws a look from the talent instead. A payload from before the field is
  failed at the top of `CharacterSheetWorkflow` (`assertQueuedWithFace`).
- **One run makes every look.** In the plan the default sheet is the look's
  upstream, with the ordinary rules: a default this run makes puts the look
  in the same run (a look that was done goes stale by cascade, since its
  face is about to move). `buildPlanReferences` drafts such a look without
  a face (`lookSheetsAfterDefault`), and `UpdateStaleShotsWorkflow` draws it
  in a second references wave from the sheet the run just landed. A default
  that fails or parks fails the look, which holds the shots that wear it.
- **Upload** of a non-default look is allowed at any time (decided
  2026-10-07): the user supplies the image, so nothing is drawn from a face.
  It is stamped with the face that exists at upload, null when none, so it
  reads stale once a default sheet lands (or a new one replaces it). Only
  Generate waits for the default sheet.
- **Recast** redraws the default look only, and re-renders the shots that
  wear it. Other looks a scene wears go stale once the new sheet lands,
  with their shots, and the next Update or Continue redraws them. The
  recast result names them (`looksLeftStale`) and the panel says so.
- **Existing look sheets go stale (decided 2026-10-07).** Every
  non-default look sheet made before this change was stamped without a
  face, so it reads stale once its default sheet exists, and the plan
  redraws it (credits), with the shots that wear it. No legacy hash shape
  keeps them fresh.

Each person look's sheet is its own BytePlus portrait asset (the pool keys by
stored URL). One sheet per look, shared by every sequence, is what keeps a
series inside the ~45-slot pool: `byteplus-ark.md` has the numbers.

## Hashes and staleness

- **Sheet hash reads no style (#2017)**: the bible's `rendering` ("Photoreal
  live action", "3D animated, Pixar-like") is what a sheet takes from a
  style, and it is the character's, so every sequence hashes the shared
  sheet alike. The sequence's palette, grade and mood apply at the shot. A
  digest stamped before this (`pre-rendering`) is verified with the
  sequence style's digest until `LEGACY_HASH_UNTIL`; a verify with no
  sequence in view checks the current shape only.
- **Sheet hash**: the clothing keeps the bible's old key
  (`characterBible.standardClothing`), fed from the look; `styling` (the
  effective one, #2065) joins only when set, in every digest shape. A backfilled default look therefore hashes
  to the digest its sheet was stamped with. On every other look,
  `faceSheetVersionId` (the default look's selected sheet version, or that
  look's id when the pointer is still null — the #1419 row) joins the
  same way, in every digest shape including the legacy ones, and only when
  set. A look sheet drawn before that face existed goes stale once the
  default sheet is completed, and is redrawn from it.
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
- No `distinguishingFeatures` (#2065): a permanent mark is physical
  description, the rest is the first look's styling. A response recorded
  with the field folds it into the first look.
- A repeated look name in one response gets a number (`Gala`, `Gala 2`).
- After a re-analysis, a look the script no longer names is soft-removed
  only when nothing is lost: every version of it came from analysis, it has
  no sheet and no scene wears it. A look a person made or edited, one with a
  sheet, and one a scene wears are never touched. A removed look the script
  names again comes back as the same row.
- Voice design sees no outfits (`withoutLooks`); the shot rewrite sees only
  the look worn in that shot's scene (`wornLookOnly`).
- A character the library or another sequence holds (#2050) is not synced:
  `characterLooks.linkFromAnalysis` matches each look the model named (by
  id, or by name among every live look she has) and adds a look only for a
  name she lacks. No look of hers is rewritten or
  removed by another sequence's analysis. See `team-characters.md`.

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
- UI: the character panel has a row of looks. The default chip is badged
  "Default look", and the sheet heading says "Default look" while that look
  is open. The line under the chips names it ("This is the default look,
  Clean white shirt…"). On any other look the heading is that look's name,
  and the line says it is drawn from the default look. Generate stays
  disabled until the default look has a sheet — the same sentence the
  refusal returns. Upload is always enabled. A scene's look picker labels the default "(default look)".
  MCP: see `mcp-capability-map.md`.

## Traps

- `continuity.characterLooks` is optional in the type: scenes stored before
  looks have no map, and continuity is read as typed JSON with no parse seam
  to default it at. Missing and `{}` both mean "everyone in their default".
- Scene continuity is compared with `continuityKey` (`scene-narrative.ts`),
  which keys the picks separately: a key-list JSON replacer empties nested
  objects.
- Never read `characters.legacy*` sheet columns or
  `character_bible_versions.legacyStandardClothing` outside the fallbacks.
- Never read `legacyDistinguishingFeatures` or a look's `storedStyling` to
  show or prompt with: `styling` already holds the text (#2065). Never write
  a look version from `styling` when copying one forward: that is the move.
  Copy `storedStyling`.
