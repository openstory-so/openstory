# Native ElevenLabs

Character TTS and Voice Design go to `api.elevenlabs.io` via
`@tanstack/ai-elevenlabs` (`elevenlabsSpeech`) and `@elevenlabs/elevenlabs-js`
(Voice Design / create-voice — the adapter does not wrap those). **Platform
key only** (`ELEVENLABS_API_KEY`): designed voices live in the account that
created them, so there is no team BYOK and `'elevenlabs'` is not on
`API_KEY_PROVIDERS` (same shape as `ARK_API_KEY`). Workflows spend the key
through `scopedDb.credentials.resolveKey('elevenlabs')`.

`ELEVENLABS_BASE_URL` is the e2e hook on both the TanStack TTS adapter and
the official SDK (default `https://api.elevenlabs.io`, no `/v1` suffix —
paths include it). Playwright points it at the main aimock on `:4010`,
which already dispatches `POST /v1/text-to-speech/{voice_id}`
(`onElevenLabsTTS`). Fixtures live under
`e2e/fixtures/recorded/elevenlabs/`. Replay injects
`ELEVENLABS_API_KEY=test-mock-key`; record uses the real key from
`.env.local` and aimock's `providers.elevenlabs` proxy. Voice Design
(`/v1/text-to-voice/*`) is not in aimock yet. Under `E2E_TEST` the via
stays off unless the base URL is also set, so a laptop key cannot bill
replay.

Pricing is a static card (`src/billing/elevenlabs-pricing.ts`), merged into
the effective map like BytePlus: TTS per 1000 characters (v3 / Multilingual v2
$0.10, advertised **2026-09-11**), Voice Design per call ($0.30, a
conservative 3 × 1000-char preview over-estimate). `recordFalUsage: false`,
unaudited like xAI/Google/Ark spend. Do not alias onto
`fal-ai/elevenlabs/music` — that is a different product.

**Character voices (#1553).** `sequences.generateVoices` (Generate dialog
"Voices" switch, off by default) is the sequence default; `characters.useVoice`
overrides it per character (NULL = inherit) — resolve with `usesVoice()`.
The launcher refuses the flag when `isElevenLabsConfigured()` is false and
the Generate dialog hides the switch (`getVoiceDesignAvailableFn`).
In-flight Voice Design is a stills-style husk (#1715): a
`character_voice_versions` row with `status: 'generating'` (no `voiceId` /
previews yet) and `characters.pendingPromoteVoiceVersionId` pointing at it.
`generateCharacterVoiceFn` and `CharacterBibleWorkflow` insert the husk
before trigger / spawn; a second Generate while live no-ops. The current
saved voice stays until the husk promotes (do not release first). The child
stamps `workflowRunId` from `event.instanceId` on its first step so reconcile
can verify the child (bible insert has no run id). Persist completes that
row in place and selects it only if the pointer still names it. Picking a
library voice or an older history row mid-run clears
`pendingPromoteVoiceVersionId` (demote); persist then fails the husk and
releases the unused ElevenLabs id. `onFailure` and the reconcile sweep mark
the husk failed (5 min verified with a run id; 30 min blind-fail if none).
Verified means the husk is older than 5 min and `resolveRunState` is not
`null`/`unknown` — an in-flight stamped run is skipped. Blind 30 min is for
unstamped husks (insert-then-crash, or bible spawn before
`stamp-voice-claim-run`). A stamped bible child running up to the 30 min
spawn timeout is protected by the in-flight skip, not the blind timer.
The card shows a Pending take while a generating husk exists; history lists
completed rows that have a `voiceId`.
`CharacterBibleWorkflow` spawns a `CharacterVoiceWorkflow` child per
_speaking_ character (`speakingCharacterIds()`: a bible name sharing a
non-stopword token with a dialogue speaker cue, or equal to it once
NFKC-normalized, so any script and one-character names such as 李 match —
articles and honorifics never match; every character when a blank cue is present, which the
shot-list call (#1585) emits only for a voice nobody could attribute; nobody
when there is no dialogue at all). Cues are the shot-list call's per-shot
lines, spelled as the cast list spells them, with narration spoken by the
voice-only entry — `extractDialogueFromSlice` is only the streaming preview
and never reaches the matcher. A voice-only character (`voiceOnly`, no
sheet) is the usual narrator and gets a voice like anyone else. The child
runs for each such character that resolves true and has no `voiceId` yet.
A failed voice child is logged and the run continues — that character's
lines just have no designed voice for TTS. The LLM drafts `voiceDescription` when empty
(`phase/voice-design-chat`), Voice Design's previews are parked in R2
(`characters.voicePreviews`, AUDIO bucket) and the first is saved as the
voice; "Use" on another take saves it instead (`chooseCharacterVoiceTakeFn`,
which writes the new id then releases the old, and moves the take to the
front — while `voiceId` is set, `voicePreviews[0]` is the saved voice; a gone
preview is reported as an expired take — ElevenLabs uses HTTP 400
`voice_not_found`, not 404). Each preview keeps a 1-based `takeNumber`
stamped at design (and lazily on promote for older rows) so the In use card
shows Take 2 after promoting the second preview, not a generic “Designed
take” (#1709). A `generatedVoiceId` can be saved once; after create()
succeeds (or ElevenLabs says it already did / the preview aged out) the
take is `unusable` and Use this take is hidden — the R2 MP3 stays. Previews cost no slot; a saved voice is an
**account-wide** ElevenLabs slot, so the id is shared by copy (talent ↔
character at cast / save-to-library) and freed only through
`releaseVoiceIfUnreferenced` (`getVoiceReferenceCount` over both tables,
**provider delete first, row write second** so a failed delete stays
retryable; `heldBy: 1` when the caller's own row still holds the id) on
character soft-delete, per-character switch-off, choose-take, recast to a
talent with a different voice, sequence archive (before the status flip, so
a failed release is retryable), talent delete and regenerate — never a bare
delete, and the upsert keeps a voice the row already holds. Billed at
`VOICE_DESIGN_COST` per design call; pre-flight prices one call per
estimated character (`generateVoices` on `estimateStoryboardCost`), the
in-run gate the real speaking count. **Voices are versioned (#1657):** every
`updateVoice` write appends a `character_voice_versions` row with an explicit `source`
('analysis' | 'generated' | 'library' | 'user-edit' | 'disabled' |
'removed' — never inferred from which columns moved) and moves
`characters.selectedVoiceVersionId`, the only selection pointer, whose values
the voice columns mirror. `createdBy` is the person whose action made the
version — required on `updateVoice` so no writer forgets it, null when nobody
did (the cast-records seed). 'removed' means the character dropped its voice id;
only `releasedAt` means the ElevenLabs slot was actually freed.
`releaseVoiceIfUnreferenced` stamps `releasedAt` on every row holding the id
it deletes — and on one it finds already gone at ElevenLabs (404 or 400
`voice_not_found`) — and
`selectVoiceVersion` refuses a released row, because that id no longer exists
at ElevenLabs and would 404 at TTS. A failed release AFTER a committed voice
switch is logged, not thrown (`releaseReplacedVoice`): the switch stands and
the old id's slot stays held.

**Dialogue audio (#1554, #1657).** An audio reference, like a character
sheet: the `dialogue` stage (after images, before motion) runs ElevenLabs
**Text to Dialogue** (`eleven_v3`) over every line whose speaker has a `voiceId` and no
`voiceToken` (uploaded element or `__video_model__` opt-out). **Record wide,
keep narrow.** Acting quality comes from what the call hears: v3 acts the
turns it is given against each other, so a shot recorded alone is a cold read
of a reply the model never heard — the call speaks the whole conversation.
What is KEPT is narrow, so one edit disturbs one shot: only a shot whose
working-set clip no longer matches its lines (`matchingDialogueClips` empty →
`adoptShotIds`) adopts the new audio; every other shot keeps the section it
had, so nothing of theirs goes stale. Three tables, all append-only:

- `shot_dialogue_versions` — the authored lines, one selected row per shot.
- `dialogue_recordings` — one row per ElevenLabs call, the **whole file** as
  it came back (`storageKey`, `url`, `durationSeconds`, per-turn `turns`,
  `inputHash` = `recordingKey` = ordered voiced turns with shot ids + voice
  ids + the words + tone + TTS model + stability). Each turn also stamps its `voiceId` and
  `ttsModel` in the clear — the hash cannot be read back. No selected flag, no
  per-shot copies, never joined or concatenated.
- `shot_dialogue_sections` — a time range (`fromSeconds`–`toSeconds`) of a
  recording, one selected row per shot. A recording inserts a row for EVERY
  shot it spoke: `source: 'recorded'` and selected for the shots it was made
  for, `source: 'context'` and unselected for the shots that were only spoken
  so the others had something to answer. Section rows hold no URL. CHECK
  constraints hold the shape:
  `from_seconds >= 0 AND to_seconds > from_seconds`, a discarded row cannot be
  selected, and `dialogue_recordings.duration_seconds > 0`; `appendRecording`
  refuses a section that ends past its recording.

Picking a context reading ("promote") is the same `selectSection` as picking
an older reading — there is no second code path.
`selectShotDialogueSectionFn` refuses a row whose `sourceKey` no longer
matches the shot's lines and one longer than `dialogueFitBudget` allows, then
cuts, then `selectSection` moves the pointer and writes `shots.audioClips` in
one batch.
`appendRecording` is one batch (recording, clear the adopting shots' selected
sections, insert all sections) with ids generated inside the workflow step
and `onConflictDoNothing`, so a replay is idempotent.
`discardShotDialogueSectionFn` → `discardSection` soft-discards a reading
(`discardedAt`; the list omits it, select refuses it). Discarding the shot's
CURRENT reading clears `shots.audioClips` in the same batch — a shot must not
keep audio cut from a reading that is gone — so the next render records. The
recording file stays: other shots may hold sections of it.
`regenerateShotDialogueFn` ("Regenerate dialogue" / "Generate dialogue" in the readings
list) is the on-demand recording: it builds the shot's scene job with
`sceneDialogueJobs`, sets `forceAdoptShotIds: [shotId]` so
`planSceneAdoption` adopts the shot even though its clip still matches, and
triggers `DialogueAudioWorkflow` with its own reservation
(`ownsReservation`). Still the whole conversation, still through a claim;
scene-mates whose clips match keep them.
A shot's dialogue audio reads out of date when its CURRENT reading no longer
matches (`mismatch` on `listShotDialogueSectionsFn`: `voice` when only a
voice id moved — same version id, or the same words with the key's voice
column dropped — else `lines`). The readings list shows it as the amber
status line with Regenerate; the video's "Stale" chip is the segment verdict,
so every voice or reading change also invalidates `segmentKeys.list`.
"Update all" counts a stale dialogue reading and a stale video the same way it
counts a stale still: the rail dots, the scene/sequence summary and the confirm
all see them. Dialogue is its own cascade depth between images and video, so a
voice change can be re-recorded without paying to re-render the clips; the
confirm names the two costs separately. Smart retry records each scene once
(`snapshotBatchDialogue`) before it fans out, the same as Generate all motion
and Update Stale. A conversation over `DIALOGUE_TAKE_CHUNK_CHARS` (2,000)
splits at a **shot boundary**, never inside a shot (`chunkTakeLines`); each
chunk is its own recording, and only chunks holding an adopting shot are
recorded at all. `recordDialogue` (`src/motion/server/record-dialogue.ts`) is
the one entry: `DialogueAudioWorkflow` calls it per scene, and motion's
fallback (clip missing, or the voice/lines moved since) calls it with
`lines: input.dialogueContext` — the `contextWindow` snapshotted at the
trigger, the shot's own turns plus whole neighbouring shots grown outward
while under the chunk limit — and `adoptShotIds: [shotId]`, so it records the
window and keeps only its own shot.

**The shot is the one source of lines, and the only place they are written.**
What a shot says is resolved by ONE ladder — `resolveShotDialogue`
(`src/shots/shot-dialogue.ts`), built per request as `shotDialogueResolver`
(`src/shots/server/shot-dialogue.ts`):

1. the shot's selected `shot_dialogue_versions` row (an EMPTY row is an answer:
   "this shot lost its lines");
2. else `shot_prompt_versions.dialogue` on its selected motion row — only rows
   from before #1657 have one; **nothing writes that column any more**;
3. else the lines the script stamps onto it (`deriveShotDialogueLines`).

Every reader goes through it — render triggers, the recording context
(`dialogueContextFor`), the staleness read (`loadLiveShotInputs`), the prompt
preview, the reading-select guard and the UI (`ShotView.dialogue`) — so the
recording, the prompt text and the panel cannot disagree. It is enforced at
one seam: `motionPromptFromVersion(version, dialogue)` takes the resolved
dialogue as a REQUIRED argument, so no builder can assemble a prompt around a
row's own copy. A workflow cannot read the node, so its form of the ladder is
fed from the payload (`dialogueLinesByShotId`; a continue snapshots EVERY shot
resolved in `refreshCheckpointFromCast`), and the motion-prompt LLM's own
`dialogue` output is never a source of lines. Before a pre-#1657 shot's
selected prompt row is superseded, `promoteLegacyDialogue`
(`shot-prompt-versions.ts`) moves its lines — and any voice bound to them —
onto a `shot_dialogue_versions` row, so rung 2 is never stranded.

**Recorded once per scene, everywhere.** The `dialogue` stage is not the only
caller. Every batch-style trigger — Generate all motion, add-a-video-model,
Update Stale — snapshots `snapshotBatchDialogue` (`src/shots/server/shot-dialogue.ts`):
each shot's `voicedLines`, its matching clips and its fallback
`dialogueContext`, plus `dialogueRecording` — ONE `DialogueAudioSceneJob` per
scene that holds a shot with no matching clip — and `ttsChars` priced per scene.
`MotionBatchWorkflow.recordScenesOnce` and `UpdateStaleShotsWorkflow` run
`DialogueAudioWorkflow` over those jobs BEFORE they fan out, and the children
only attach. Without it a recast (the voice id is in the clip key, so every
shot the character speaks in loses its clip at once) recorded the scene once
per speaking shot. Never fatal: a scene that cannot be recorded leaves its
shots to record themselves in context. Smart retry and single-shot Generate
still record per shot — they start one motion run per shot, with no parent to
record first.

**Claims — a recording lands like every other generation (#1085 pattern).**
`shot_dialogue_claims`, one row per shot about to take new audio; a reading
cannot be its own placeholder because a section needs a recording and a range.
`recordDialogue` is the single owner:

- **Claim** (`claimRecording`, first step, before anything is spent): a
  `generating` row per adopting shot. The live unique index
  `(shot_id, pending_source_key)` makes a second run for the same shot and the
  same words stand down — it adopts only the shots it claimed, and with none
  it records nothing.
- **Demote** (`demoteLiveClaims`, in the SAME batch as the user's write):
  picking a reading (`selectSection`), changing the lines (`write`) or
  restoring them (`selectVersion`) nulls `pendingSourceKey`. The run finishes;
  it can no longer take the selection. `cancelShotDialogueClaimFn` does the
  same on request — it does not stop the run, which records for other shots.
- **Complete** (`appendRecording`): one transaction. Every reading lands
  unselected; then, per adopting shot, clear-selected → select → write
  `shots.audioClips` → complete the claim, each carrying the same
  `claimIsLive` predicate, so there is no gap between checking the claim and
  acting on it and the pointer and the clip can never disagree.
  `shots.setAudioClips` is gone: `appendRecording`, `selectSection` and
  `discardSection` are the only writers of a shot's dialogue clip, and each
  moves the pointer in the same batch. A demoted or cancelled claim's reading
  is kept, unselected, pickable later. `recordDialogue` returns clips only for
  PROMOTED shots; `MotionWorkflow` then renders from the shot's live clips
  (`dialogue-audio-from-shot`) and fails the shot only if it has none.
- **Fail**: the recorder fails its own claims when it gives up
  (`fail-claims` step); `reconcileDialogueClaimsPass` (the 5-minute sweep)
  fails the claims of a run that died.

The panel shows a claim as "Generating…" with Cancel
(`listShotDialogueClaimsFn`; the query key sits under `dialogueSections` so the
realtime `dialogue-audio` event refreshes both).

**Going back.** `listShotDialogueVersionsFn` / `selectShotDialogueVersionFn`
(the History list in the prompt editor) re-point the selected version, and
that is the whole change: every reader follows the pointer. The current
reading stops matching (the next render records), and a reading of the
restored wording becomes usable again — `sourceKey` finds it.

`shot_dialogue_versions` is the authored node. The shot-list pass seeds a `prompt` row per shot; the prompt
editor appends `user-edit` (`scopedDb.shotDialogue.write`, which returns the
selected row unchanged when the lines are identical). The save touches one
shot's row, so it cannot drop a concurrent edit to another shot — the
whole-scene list it replaces could. **Speaking order is shot order, then line
order within the shot** (`sceneConversation`), read at the moment of use, so
a shot reorder needs nothing restamped and leaves every shot's audio valid.
The script's `originalScript.dialogue` stays as the LLM's seed, and a shot
with no row yet is derived at read time (`deriveShotDialogueLines`: lines
stamped with the shot's number; unstamped pre-#1585 lines go to the first
shot only) — so there is no backfill migration. Pure helpers:
`src/shots/shot-dialogue.ts`. A turn's `index` is shot-relative, so every
#1554/#1651 helper (`dialogueClipSourceKey`, `matchingDialogueClips`,
`spokenLinesFor`, `withSpokenText`, the rewrite merge) works unchanged on one
shot's lines; a turn's place in the conversation is its array position, never
stored.

**Cut files are a cache.** A video model needs a file URL, so the selected
section is materialised by `cutAudioSection`
(`src/motion/server/cut-audio-section.ts`) and `shots.audioClips` (the working
set, shape unchanged) holds that URL; the clip's `id` IS its
`shot_dialogue_sections.id` and it stamps `recordingId`. The cut **never
loads the recording**: a ranged read of the first 4 KiB parses the PCM header
(`parseWavHeader`), the byte range is frame-snapped from the section's times,
and the output is a new 44-byte header, the ranged body from R2 as a stream
(`readStorageStream`), then silence in ≤16 KiB blocks — wrapped in
`FixedLengthStream` since the total is known and `r2.put` rejects an
unknown-length stream. The key is deterministic
(`…/dialogue-sections/<recordingId>_<fromMs>_<toMs>_<minMs>.wav`), so an
existing file is returned without re-cutting and a replay or a re-select is
free. **Padding to the provider floor (H3 Max 2s) happens at cut time**,
which is why the floor is in the key: the same section cut for a model with a
different floor is a different file. The tail trim is **measured once at
record time** (`trimmedEndSeconds`, in place, no copy) and stored as the
section's `toSeconds`, so the cut is pure arithmetic. The silence between two
turns belongs to the shot about to speak (`shotSliceWindows`). Bytes never
cross a `step.do` (#1645): the recording step uploads the whole WAV and
returns `{ recordingId, storageKey, turns, windows }`; each adopting shot is
cut in its own step.

**Relation to #1577** (`@BEACH:3-8`, a section of a clip or audio element per
shot). Same idea — one file, each shot uses a range of it, server-side cut
cached by (file, from, to). Where the range lives differs: #1577 writes it in
the mention because a person chose it and the shot's text should own it; a
dialogue range is machine-made and changes on every
re-record, so it is DATA on the shot (`shot_dialogue_sections`), never
`@TOKEN:3-8` prompt text that would re-stale the prompt each time. Recordings
are not `sequence_elements` rows either: nobody binds or names one.

Motion attaches the stored clip and stamps it onto
`shot_prompt_versions.audioClips` (provenance of the render). Tone maps to v3
audio tags on each turn. User-bound `voiceToken` elements already ride as
`@AudioN` and are not re-synthesised. The clip binds as `DIALOGUE` /
`@Audio1`. Voice ids + lines + tone + TTS model fold into the **video
manifest** as `audioSourceKey` **only when a voice is present** (same
shape-stable trick as `usesStartFrame` / `referenceOnly`) — not the
motion-prompt hash: the LLM never sees the id, so a voice change must not
rewrite the prompt. The manifest also stamps `audioClipIds` — for a generated
dialogue clip, the section id, which is the selection pointer
`audioSourceKey` cannot express — and `referenceKeys`
(`character:<id>:<sheetVersionId|url>`, `location:…`, `element:…` for every
reference the render was sent, `src/motion/reference-provenance.ts`), dropped
from the hash body when null or empty so no stored digest moves.
`isSelectedVersionStale` compares them against live identity:
`audioClipsMoved` reads the manifest's `audioClipIds` against the shot's
working-set clip ids (`audioClipIdsByShot`, from `shots.audioClips`) and
differs → stale, so picking another reading re-stales that shot's video and
no other; an entry with no clip ids is not compared (a voice appearing is
`audioSourceKey`'s job), and older manifests hold the ids the working set
still holds, so nothing old flips. Duration is snapped on **both** sides —
together closing #767 and the reference / element-media gaps on the docs
dependency graph. Shot duration is raised to cover the audio.

**Fitting the section to the clip (#1651).** v3 takes no target or maximum
duration, so length is discovered, not requested. The ladder runs **per
adopting shot over the wide recording** (#1657): a section whose padded
length is over its shot's limit sends THAT shot's turns to the rewrite
(`shortenDialogueLines`, `src/motion/server/fit-dialogue-clip.ts`) and the
chunk is re-recorded, because the other shots' delivery is not independent of
it. Shots that are only context are never checked — their audio is not being
kept. Only the final attempt's recordings get rows. The rungs:
`convertWithTimestamps` returns per-turn voice segments (the character
alignment is never read) → `trimmedEndSeconds` pulls the section's end back to
whichever is LATER of the last audible sample and the end of the shot's last
voice segment (so a short-reporting segment cannot clip a word, and a segment
saying "silent" cannot be overruled by a noise floor) → still over, an LLM (`phase/shorten-dialogue-chat`) tightens
the turns and the chunk is re-recorded, bounded at
`MAX_DIALOGUE_FIT_ATTEMPTS` (2) → still over, the shot **fails here** with
the measured numbers. No time-compression rung: speeding speech up alters the
performance that was cast. The rewrite merges **by turn index**, so a dropped
or invented turn cannot move a speaker or a voice. Two budgets from
`dialogueFitBudget`: `limitSeconds` is the refusal line
(`dialogueAudioMaxSeconds` — the tightest of each model's audio window and
longest grid clip — minus 0.2s slack, hence H3 Max's 14.8s; the slack is the
padding and rounding the end of the shot's last voice segment does not
measure); `targetSeconds` is
what a rewrite aims at, the SHOT's own length when shorter, so the reading
fits the cut rather than stretching it. Speech between the two is kept — the
clip stretches. A rewritten reading records its delivered wording on the
section and its clip as `spokenLines` (and on the recording as
`turns[].spokenText`) while `sourceKey` keeps keying the AUTHORED lines, so
nothing re-records and no digest moves; the manifest's `audioSourceKey` is
built from the authored lines for the same reason (#1671). Motion reads the
delivered wording back with `withSpokenText` before assembling, because the
prompt drives lip movement. Seedance is the exception (BytePlus guidance): a
line on the conversation recording is not repeated in the prompt at all, or
the model re-voices it over the track — `buildSeedancePrompt` names the clip
as the master audio track and points the speakers at it for lip-sync, in
speaking order. Other models still get the words. `maxCombined` is checked across files in
`unusableShotReferenceLines` — H3 Max takes 2–15s each AND 15s summed, so
two 10s voices each pass and together do not. The shot-list prompt is the
prevention half (a words-per-second placement budget per shot), and
`splitOverfullShots` enforces it after parse: a shot over the longest clip's
word budget is split between lines into back-to-back shots. Preflight
reserves the TTS cost on the references slice (static card), including when
Voices is off — talent may already hold a `voiceId`. The optimised-prompt
JSON carries the audio refs for paste-into-Videos. Models with no audio
reference slot (Grok, Omni Flash, Kling) still get a section and a cut clip
in References; motion just does not bind it.

Out of scope here: voice cloning from an uploaded sample, realtime/agents,
auditioning/regenerating a single line from the scene panel.
