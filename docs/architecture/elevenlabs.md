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
front — while `voiceId` is set, `voicePreviews[0]` is the saved voice; a 404
is reported as an expired take). Previews cost no slot; a saved voice is an
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
write appends a `character_voice_versions` row with an explicit `source`
('analysis' | 'generated' | 'library' | 'user-edit' | 'disabled' |
'released' — never inferred from which columns moved) and moves
`characters.selectedVoiceVersionId`, whose values the voice columns mirror;
`releaseVoiceIfUnreferenced` stamps `releasedAt` on every row holding the id
it deletes, and `selectVoiceVersion` refuses a released row, because that id
no longer exists at ElevenLabs and would 404 at TTS.

**Dialogue audio (#1554, #1657).** An audio reference, like a character
sheet: the References stage (after Voice Design) runs ElevenLabs **Text to
Dialogue** (`eleven_v3`) over every line whose speaker has a `voiceId` and no
`voiceToken` (uploaded element or `__video_model__` opt-out). **One take per
SCENE, sliced per shot** (`recordDialogueTake`): v3 acts the turns it is
given against each other, so a shot recorded alone is a cold read of a reply
the model never heard. The scene's conversation is recorded whole, cut at the
provider's own per-turn voice segments (`sliceWav`), and the slices are
mirrored onto `shots.audioClips` (working set) each stamping `takeId`. The
take itself lands on `scene_dialogue_takes` (url, duration, segments, the
per-shot `clips`, `inputHash` = `dialogueTakeKey` = ordered voiced turns with
shot ids + voice ids + tone + TTS model + stability), append-only with one
selected row per scene; `selectSceneDialogueTakeFn` puts another take's
slices back on the shots. A scene over `DIALOGUE_TAKE_CHUNK_CHARS` (2,000)
splits at a **shot boundary**, never inside a shot, and the chunks are joined
with their segment times offset. Bytes never cross a `step.do` (#1645): each
chunk is parked in R2 and the assemble step reads them back by key.

**The scene is the one source of lines.** `scene_dialogue_versions` is the
authored node — append-only, one selected row per scene, every line naming
its shot by `shotId` (an id, so a reorder needs no restamp). The shot-list
pass seeds a `prompt` row; the prompt editor appends `user-edit`
(`replaceShotLines`). The script's `originalScript.dialogue` stays as the
LLM's seed, and a scene with no row yet is derived at read time
(`deriveSceneDialogueLines`) — so there is no backfill migration. Pure
helpers: `src/shots/scene-dialogue.ts`; `lineIndex` is the scene position,
`index` stays shot-relative so every #1554/#1651 helper works unchanged on a
slice.

Motion attaches the stored clip (synthesising only if it is missing or the
voice/lines moved) and stamps that take onto `shot_prompt_versions.audioClips`
(provenance of the render). Tone maps to v3 audio tags on each turn. User-bound
`voiceToken` elements already ride as `@AudioN` and are not re-synthesised.
The clip binds as `DIALOGUE` / `@Audio1`. Voice ids + lines + tone + TTS model
fold into the **video manifest** as `audioSourceKey` **only when a voice is
present** (same shape-stable trick as `usesStartFrame` / `referenceOnly`) —
not the motion-prompt hash: the LLM never sees the id, so a voice change
must not rewrite the prompt. The manifest also stamps `dialogueTakeId` (the
take the clips were cut from — a selection pointer `audioSourceKey` cannot
express) and `referenceKeys` (`character:<id>:<sheetVersionId|url>`,
`location:…`, `element:…` for every reference the render was sent,
`src/motion/reference-provenance.ts`), both dropped from the hash body when
null or empty so no stored digest moves. `isSelectedVersionStale` compares
them against live identity, with duration snapped on **both** sides —
together closing #767 and the reference / element-media gaps on the docs
dependency graph. Shot duration is raised to cover the audio; a clip under
the provider floor (H3 Max 2s) is padded with silence.

**Fitting the take to the clip (#1651).** v3 takes no target or maximum
duration, so length is discovered, not requested. The ladder runs **per shot
slice over a scene-wide recording** (#1657): a slice over its shot's limit
sends THAT shot's turns to the rewrite and the whole scene is re-recorded,
because the other shots' delivery is not independent of it.
`fitDialogueClip` (`src/motion/server/fit-dialogue-clip.ts`) is the per-shot
twin, still used by motion's standalone synthesis; both share
`shortenDialogueLines`, so the rungs behave identically: `convertWithTimestamps`
returns alignment + voice segments → `trimWavTrailingSilence` cuts the tail
back to whichever is LATER of the last audible sample and the alignment end
(so a short-reporting alignment cannot clip a word, and an alignment saying
"silent" cannot be overruled by a noise floor) → still over, an LLM
(`phase/shorten-dialogue-chat`) tightens the turns and the take is
re-recorded, bounded at `MAX_DIALOGUE_FIT_ATTEMPTS` (2) → still over, the
shot **fails here** with the measured numbers. No time-compression rung:
speeding speech up alters the performance that was cast. The rewrite merges
**by turn index**, so a dropped or invented turn cannot move a speaker or a
voice. Two budgets from `dialogueFitBudget`: `limitSeconds` is the refusal
line (`dialogueAudioMaxSeconds` — the tightest of each model's audio window
and longest grid clip — minus 0.2s slack, hence H3 Max's 14.8s; the slack is
the padding and rounding the alignment end does not measure);
`targetSeconds` is what a rewrite aims at, the SHOT's own length when
shorter, so the take fits the cut rather than stretching it. Speech between
the two is kept — the clip stretches. A rewritten take records its delivered
wording on the clip as `spokenLines` (and on the take as
`segments[].spokenText`) while `sourceKey` keeps keying the AUTHORED lines,
so nothing re-synthesises and no digest moves; the manifest's
`audioSourceKey` is built from the authored lines for the same reason
(#1671). Motion reads the delivered wording back with `withSpokenText`
before assembling, because the prompt drives lip movement. `maxCombined` is checked across files in
`unusableShotReferenceLines` — H3 Max takes 2–15s each AND 15s summed, so
two 10s voices each pass and together do not. The shot-list prompt is the
prevention half (a words-per-second placement budget per shot). Preflight reserves the TTS cost on the references
slice (static card), including when Voices is off — talent may already hold
a `voiceId`. Clip ids are stamped on `VideoManifestEntry.audioClipIds`.
The optimised-prompt JSON carries those audio refs for paste-into-Videos.
Models with no audio reference slot (Grok, Omni Flash, Kling) still mint
the clip in References; motion just does not bind it.

Out of scope here: voice cloning from an uploaded sample, realtime/agents,
auditioning/regenerating a single line from the scene panel.
