---
title: Analyze Script Workflow
description: End-to-end pipeline that transforms a script into a storyboard with images, motion video, and music
section: Developer Guide
order: 5
---

End-to-end pipeline that transforms a user's script into a complete storyboard with images, motion video, and music.

## High-Level Overview

```mermaid
flowchart TD
    Verify["<b>Verify + Prepare</b> · <1s<br/>IN: sequenceId, userId, teamId<br/>OUT: script, aspectRatio, styleConfig,<br/>analysisModelId, imageModel, videoModel"] --> Poster
    Poster["<b>Generate Poster</b> · non-critical<br/>IN: title, script, styleConfig<br/>OUT: posterUrl on sequence"] --> SceneSplit

    subgraph "Phase 1 — Script Analysis · ~3min"
        SceneSplit["<b>Scene Splitting</b> · two parallel LLM calls · ~3min<br/>IN: script, aspectRatio, autoGenerateMotion<br/>OUT: scenes[], title, shotMapping[], bibles[]<br/><i>shots + preview images created progressively</i>"]
    end

    SceneSplit --> P2

    subgraph "Phase 2 — Casting Characters & Locations (parallel) · ~2.5min"
        P2["<b>Promise.all</b>"]
        P2 --> TalentSub
        P2 --> LocationSub

        subgraph TalentSub["talentMatchingWorkflow"]
            CharExtract["<b>Character Extraction</b> · LLM<br/>IN: scenes[]<br/>OUT: characterBible[]"]
            TalentMatch["<b>Talent Matching</b> · LLM<br/><i>skipped if no suggestedTalentIds</i>"]
            CharExtract --> TalentMatch
        end

        subgraph LocationSub["locationMatchingWorkflow"]
            LocExtract["<b>Location Extraction</b> · LLM<br/>IN: scenes[]<br/>OUT: locationBible[]"]
            LocMatch["<b>Location Matching</b> · LLM<br/><i>skipped if no suggestedLocationIds</i>"]
            LocExtract --> LocMatch
        end
    end

    subgraph "Phase 3 — References & Prompts (parallel) · ~1min"
        CharSheets["<b>Character Sheets</b> · image gen ×N chars<br/>IN: characterBible[], talentCharacterMatches[]<br/>OUT: charactersWithSheets[]"]
        LocSheets["<b>Location Sheets</b> · image gen ×N locs<br/>IN: locationBible[], libraryLocationMatches[]<br/>OUT: locationsWithSheets[]"]
        VisualPrompts["<b>Visual Prompts</b> · LLM ×N scenes<br/>IN: scenes[], characterBible[], locationBible[],<br/>styleConfig, aspectRatio, analysisModelId<br/>OUT: scenesWithVisualPrompts[]"]
    end

    TalentSub --> CharSheets
    TalentSub --> VisualPrompts
    LocationSub --> LocSheets
    LocationSub --> VisualPrompts

    subgraph "Phase 4 — Frame Images, then Motion/Music Prompts (sequential) · ~3min"
        ImageGen["<b>Frame Images</b> · Fal.ai ×N scenes parallel<br/>IN: fullPrompt, imageModels[], imageSize,<br/>characterRefs[], locationRefs[] per scene<br/>OUT: imageUrls[] + variant images"]
        MotionMusicPrompts["<b>Motion + Music Prompts</b> · LLM<br/>IN: scenesWithVisualPrompts[], styleConfig,<br/>rendered starting frame (thumbnailUrl as<br/>vision input, #929)<br/>OUT: completeScenes[], musicPrompt, musicTags"]
    end

    CharSheets -->|"charactersWithSheets"| ImageGen
    LocSheets -->|"locationsWithSheets"| ImageGen
    VisualPrompts -->|"scenesWithVisualPrompts"| ImageGen
    ImageGen -->|"rendered stills (#929)"| MotionMusicPrompts
    VisualPrompts -->|"scenesWithVisualPrompts"| MotionMusicPrompts

    subgraph "Phase 5 — Motion + Music Generation (conditional) · ~1-5min"
        MotionBatch["<b>Motion Batch</b> · Fal.ai ×N parallel<br/>IN: imageUrls[], motionPrompts[],<br/>videoModel, aspectRatio, durations<br/>OUT: videoUrl per frame"]
        MusicGen["<b>Music Generation</b> · Fal.ai<br/>IN: prompt, tags, totalDuration, musicModel<br/>OUT: musicUrl on sequence"]
        MergeVideo["<b>Merge Video</b><br/>IN: videoUrls[]<br/>OUT: mergedVideoUrl"]
        MergeAudioVideo["<b>Merge Audio+Video</b><br/>IN: mergedVideoUrl, musicUrl<br/>OUT: finalVideoUrl"]
        MotionBatch --> MergeVideo
        MusicGen --> MergeAudioVideo
        MergeVideo --> MergeAudioVideo
    end

    ImageGen -->|"imageUrls"| MotionBatch
    MotionMusicPrompts -->|"motionPrompts + musicPrompt"| MotionBatch
    MotionMusicPrompts -->|"musicPrompt + tags"| MusicGen

    MergeAudioVideo --> Done
    MotionMusicPrompts -->|"if no motion/music"| Done
    Done["<b>Complete</b> · <1s<br/>OUT: generation.complete + completeScenes[]"]

    style Verify fill:#2d2d44,color:#fff
    style Done fill:#1a472a,color:#fff
```

> **Timing source:** Measured from local Cloudflare Workflows runs (Workerd via Miniflare) for a 9-scene run. As of #929, Phase 4 runs **sequentially** — frame images render first, then motion/music prompts — because the motion-prompt pass is conditioned on the actual rendered starting frame (passed to the LLM as a vision input). This trades the prior image∥prompt parallelism for image-grounded motion.

## Triggering Flow

The pipeline starts from server handlers in `src/functions/sequences.ts`:

1. **`createSequenceFn`** — Creates a new sequence record, then calls `triggerWorkflow('/storyboard', input)`
2. **`updateSequenceFn`** — If script, style, aspect ratio, or analysis model changed, triggers the same workflow
3. **`retryStoryboardFn`** — Retries a failed sequence (resets status to `processing`, re-triggers)

All three use `triggerWorkflow()` from `src/lib/workflow/client.ts`, which:

- Resolves the **Cloudflare Workflows binding** for the trigger path via `TRIGGER_TO_BINDING` (`src/lib/workflow/trigger-bindings.ts`) — e.g. `/storyboard` → `STORYBOARD_WORKFLOW`
- Calls `binding.create({ id, params: body })` to start a durable workflow instance in-process (Workerd locally, same runtime as production — no HTTP webhook, no QStash). `options.deduplicationId` becomes the instance id, making a trigger idempotent
- Returns the workflow instance id, persisted as `workflowRunId` on the relevant DB row for tracking

**Input shape (`StoryboardWorkflowInput`):**

| Field                  | Type      | Purpose                                      |
| ---------------------- | --------- | -------------------------------------------- |
| `userId`               | string    | Auth context                                 |
| `teamId`               | string    | Auth context                                 |
| `sequenceId`           | string    | Target sequence                              |
| `options`              | object    | `framesPerScene`, `generateThumbnails`, etc. |
| `autoGenerateMotion`   | boolean   | Whether to generate video for each frame     |
| `autoGenerateMusic`    | boolean   | Whether to generate music for the sequence   |
| `musicModel`           | string?   | Override music model                         |
| `imageModels`          | string[]? | Multiple image models for parallel gen       |
| `suggestedTalentIds`   | string[]? | Pre-selected talent for casting              |
| `suggestedLocationIds` | string[]? | Pre-selected locations for matching          |

## Storyboard Workflow

**File:** `src/lib/workflows/storyboard-workflow.ts`

The storyboard workflow (`StoryboardWorkflow`, a `WorkflowEntrypoint` extending `OpenStoryWorkflowEntrypoint`) validates data, generates a poster image, then delegates to the analyze-script workflow. Each unit of work runs inside `step.do('name', …)` so the Workflows engine checkpoints and auto-retries it.

```mermaid
flowchart TD
    Start["STORYBOARD_WORKFLOW.create()"] --> Verify["step.do('verify-clear-and-start-processing')"]
    Verify -->|"Validates auth<br/>Loads sequence + style<br/>Deletes existing frames<br/>Sets status = processing"| Poster["step.do('generate-poster')"]
    Poster -->|"Non-critical poster image<br/>for video player empty state"| Invoke["spawnAndAwaitChild(ANALYZE_SCRIPT_WORKFLOW)"]
    Invoke -->|"child gets its own<br/>step retry budget"| ASW["AnalyzeScriptWorkflow"]
    ASW --> Complete["mark-completed + emit generation.complete"]
```

**Step: `verify-clear-and-start-processing`**

1. Validates auth via `validateSequenceAuth()`
2. Loads sequence with `getSequenceForUser()` — checks script and style exist
3. Loads and parses the style config
4. Deletes all existing frames for the sequence
5. Sets sequence status to `processing`
6. Returns resolved models: `analysisModelId`, `imageModel`, `videoModel`

**Step: `generate-poster`**

- Generates a poster image from the script+title+style for the video player empty state
- Non-critical — failures are logged and swallowed

**Steps: `upload-poster` → `save-poster`**

- `upload-poster` streams the provider image into R2 (`uploadPosterToStorage`) so the stored URL is the origin-relative `/r2/` path and never expires (#1117). Also non-critical: an upload failure falls back to the provider URL
- `save-poster` writes `posterUrl` on the sequence and emits `generation.poster:ready` with the URL

Then spawns the `AnalyzeScriptWorkflow` child via `spawnAndAwaitChild(ANALYZE_SCRIPT_WORKFLOW, …)` (`src/lib/workflow/await-child.ts`) and awaits its completion. The child runs as its own durable instance with its own per-step retry budget.

After the analyze-script workflow completes, marks status as `completed` and emits `generation.complete`.

## Analyze Script Workflow — Phase-by-Phase

**File:** `src/lib/workflows/analyze-script-workflow.ts`

This is the core orchestration workflow. It runs durable units via `step.do()`, spawns child workflows via `spawnAndAwaitChild()`, and uses `Promise.all()` / `Promise.allSettled()` to fan child workflows out in parallel. It reads its input from `event.payload` and its instance id from `event.instanceId`.

### Phase 1: Scene Splitting (Streaming LLM)

**Sub-workflow:** `sceneSplitWorkflow` (`src/lib/workflows/scene-split-workflow.ts`)

Uses streaming LLM output to create frames progressively as scenes arrive, plus triggers preview image generation for each scene.

**Steps:**

Since #1035 the split runs as **two parallel LLM calls** (sibling `step.do`s via `Promise.all`), both over the same line-gutter copy of the script, and the LLM never re-emits script text:

1. **`scene-splitting-stream`** — the scenes call, a **boundary-annotation** contract: the model returns `boundaries[] = { hintLine, quote }` plus index-aligned `sceneMeta[]`, and `boundary-split.ts` resolves each verbatim quote to a raw offset (exact → normalized → fuzzy, monotonic cursor) and slices the ORIGINAL script — extracts are byte-verbatim adjacent substrings (`concat(slices) === script`, asserted). The stream is fed through `createStreamingSceneParser()`:
   - On each finalized boundary: persists the scene + 1:1 shot, emits `generation.scene:new` / `generation.shot:created`
   - On title detection: updates the sequence title, emits `generation.updated`
   - On `scene:updated` (a scene's `sceneMeta` entry settling): upserts the scene and triggers its preview image (fire-and-forget via `triggerWorkflow`, staggered off the meta stream so the boundary burst can't fan out all previews at once)
   - Excessive anchor repairs → one retry with feedback; a second degraded result keeps the first-pass LLM scenes. Dropped boundaries are logged and emitted as a non-fatal `generation.error`
2. **`scene-bibles`** — the bibles call: `{ characterBible[], locationBible[], elementBible[] }`. Location/element `firstMention` is `{ text, lineNumber }` on the wire; the owning scene id is derived server-side from the gutter line. After the join, scene continuity tags are canonicalized onto bible tags (`tag-reconcile.ts`) since two independent calls can disagree.
3. **`reconcile-shots`** / **`persist-scenes`** — replay-safe bulk upserts of scenes + shot links (idempotent on `sequenceId + orderIndex`).
4. **`deduct-llm-credits-scene-splitting`** / **`deduct-llm-credits-scene-bibles`** — one credit deduction per LLM call

- **Prompts:** `phase/scene-splitting-boundaries-chat` + `phase/scene-bibles-chat`
- **Variables:** `{ aspectRatio, script, elements }` (script is sanitized and line-guttered)
- **Response schemas:** `sceneSplitScenesResultSchema` + `sceneSplitBiblesResultSchema` — both under the ~3KB Anthropic strict-output grammar budget enforced by `response-schema-budget.test.ts`
- **Output:** `{ scenes[], title, shotMapping[], characterBible[], locationBible[], elementBible[] }` — `shotMapping` maps `analysisSceneId → shotId/frameId` used throughout remaining phases

### Phase 2: Casting Characters & Locations (Parallel Sub-Workflows)

After scene splitting, two child workflows run **in parallel** via `Promise.all` over `spawnAndAwaitChild(...)`:

```mermaid
flowchart LR
    P2["Scene Splitting<br/>complete"] --> TM["talentMatchingWorkflow"]
    P2 --> LM["locationMatchingWorkflow"]
    TM --> Join["Both complete"]
    LM --> Join
```

**Talent Matching Workflow** (`src/lib/workflows/talent-matching-workflow.ts`):

Bibles already exist from Phase 1. This workflow only matches.

1. Uses `input.characterBible` from scene-split (no character-extraction LLM)
2. **Talent matching** (skipped if no `suggestedTalentIds`):
   - Loads talent records from DB by IDs
   - LLM matches characters to talent
   - Deduplicates matches (each talent/character used once), emits `generation.talent:matched`
3. **Returns:** `{ characterBible, matches: talentCharacterMatches }`

**Location Matching Workflow** (`src/lib/workflows/location-matching-workflow.ts`):

1. Uses `input.locationBible` from scene-split (no location-extraction LLM)
2. **Location matching** (skipped if no `suggestedLocationIds`):
   - Loads library locations from DB by IDs
   - LLM matches locations to library entries (requires confidence >= 0.5)
   - Deduplicates matches, emits `generation.location:matched`
3. **Returns:** `{ locationBible, matches: libraryLocationMatches }`

### Phase 3: References & Prompts (Parallel Sub-Workflows)

Three child workflows spawned in parallel via `Promise.all` over `spawnAndAwaitChild(...)`:

```mermaid
flowchart LR
    P3["Extraction +<br/>Matching complete"] --> CS["characterBibleWorkflow<br/>Generate character sheets"]
    P3 --> LS["locationBibleWorkflow<br/>Generate location sheets"]
    P3 --> VP["visualPromptWorkflow<br/>Generate visual prompts"]
    CS --> Join["All 3 complete"]
    LS --> Join
    VP --> Join
```

**Character Bible Workflow** (`src/lib/workflows/character-bible-workflow.ts`):

- Generates a reference sheet image for each character (parallel per character)
- Uses talent match images as reference when available
- Uploads sheets to R2 storage
- Creates `sequence_characters` DB records

**Location Bible Workflow** (`src/lib/workflows/location-bible-workflow.ts`):

- Inserts location records into DB from location bible
- Generates establishing-shot reference images for each location (parallel)
- Uses library location reference images when matched
- Uploads to R2 storage, updates DB

**Visual Prompt Workflow** (`src/lib/workflows/visual-prompt-workflow.ts`):

- Delegates to `visualPromptSceneWorkflow` per scene (parallel via `spawnAndAwaitChild`)
- Each scene gets an LLM call that generates `fullPrompt` and `negativePrompt`. Scene `continuity` is authored in Phase 1 and is not re-emitted here.
- Merges results back into scene objects

### Phase 4: Frame Images, then Motion/Music Prompts (Sequential)

As of #929, frame images render **before** motion/music prompts (the two ran in parallel previously). The motion-prompt pass is conditioned on the actual rendered starting frame — the per-scene motion workflow reads the frame's `thumbnailUrl` and passes it to the LLM as a vision input — so the still must exist first. The motion prompt then describes movement that continues _that exact pose and composition_, instead of guessing a plausible start from scene text alone. Music has no image dependency but rides along with motion in the same child workflow, so it inherits the wait (an accepted latency cost on the non-critical music artifact).

```mermaid
flowchart LR
    P4["Visual prompts<br/>complete"] --> FI["frameImagesWorkflow<br/>Generate images + variants"]
    FI -->|"rendered stills"| MMP["motionMusicPromptsWorkflow<br/>Motion prompts + music design"]
    MMP --> Join["Phase complete"]
```

**Frame Images Workflow** (`src/lib/workflows/frame-images-workflow.ts`):

1. Builds per-scene character and location reference maps
2. For each scene, generates images with each selected model in parallel (one `spawnAndAwaitChild` per scene × model, gathered with `Promise.allSettled`):
   - Spawns the `ImageWorkflow` child (binding `IMAGE_WORKFLOW`) per scene per model
   - After each image completes, fires the shot-grid variant generation via `triggerWorkflow('/variant-image', …)` (fire-and-forget; its progress is tracked on `frame.variantImageStatus`)
3. Returns `{ imageUrls }` — primary model's URL per scene. The primary still is persisted to `frame.thumbnailUrl`, which the motion-prompt pass reads next.

**Motion + Music Prompts Workflow** (`src/lib/workflows/motion-music-prompts-workflow.ts`):

1. **Snap durations** — Snaps scene durations to video model capabilities upfront so both motion prompts and music design see identical values
2. **Parallel generation** — Motion prompts and music design run simultaneously (parallel _within_ this child; the child itself runs after frame images):
   - `MotionPromptWorkflow` — fans out one `MotionPromptSceneWorkflow` child per scene. Each per-scene call (`motion-prompt-scene-workflow.ts`) loads the rendered starting frame and, when the chosen analysis model accepts image input, attaches it to the LLM as a vision input (#929). The image's input-hash is folded into `motionPromptInputHash`, so re-rendering the still re-stales the motion prompt. When no image exists (render failed) or the model is text-only, it falls back to the text-only path.
   - `MusicPromptWorkflow` — Single LLM call classifying per-scene music requirements + generating unified prompt with tags
3. **Merge** — Combines motion prompts and music design into `completeScenes[]`
4. **Returns:** `{ completeScenes, musicPrompt, musicTags }`

### Phase 5: Motion + Music Generation (Conditional)

**Sub-workflow:** `motionBatchWorkflow` (`src/lib/workflows/motion-batch-workflow.ts`)

Only runs if `autoGenerateMotion` is enabled, a video model is set, and images were generated. A single orchestrator handles:

1. **Parallel generation** — All frame motion child workflows + the optional music workflow spawned simultaneously (`spawnAndAwaitChild` under `Promise.all`)
2. **Collect video URLs** — Reads from DB (authoritative ordering by `orderIndex`)
3. **Merge video** — Concatenates all frame videos into one sequence video
4. **Merge audio+video** — If music was generated, muxes audio onto the merged video

```mermaid
flowchart TD
    Start["motionBatchWorkflow"] --> Parallel["Promise.all"]
    Parallel --> M1["Motion frame 1"]
    Parallel --> M2["Motion frame 2"]
    Parallel --> MN["Motion frame N"]
    Parallel --> Music["Music generation<br/>(if enabled)"]
    M1 --> Collect["Collect video URLs from DB"]
    M2 --> Collect
    MN --> Collect
    Collect --> MergeV["mergeVideoWorkflow"]
    MergeV --> MergeAV["mergeAudioVideoWorkflow<br/>(if music generated)"]
    Music --> MergeAV
```

### Final: Return

Returns the `completeScenes` array.

## Data Flow: Scene Object Accumulation

```mermaid
flowchart TD
    P1["Phase 1: Scene Splitting"] -->|"sceneId, sceneNumber,<br/>originalScript (extract, dialogue),<br/>metadata, continuity,<br/>character/location/element bibles"| P2
    P2["Phase 2: Casting Characters<br/>& Locations"] -->|"talent + library matches<br/>(bibles already from Phase 1)"| P3
    P3["Phase 3: References &<br/>Prompts"] -->|"+ visual fullPrompt +<br/>negativePrompt (no components)"| P4
    P4["Phase 4: Images +<br/>Motion/Music Prompts"] -->|"Frames get thumbnailUrl +<br/>variants. Scenes get<br/>prompts.motion + musicDesign"| P5
    P5["Phase 5: Motion + Music<br/>Generation"] -->|"Sequence gets musicUrl,<br/>mergedVideoUrl, finalVideoUrl.<br/>Frames get videoUrl"| Final["Complete Scene"]

    style Final fill:#1a472a,color:#fff
```

Each phase enriches the `Scene` object. The frame's `metadata` column is updated after visual prompts to persist intermediate results. Phase 1 creates frames progressively during streaming and triggers preview images for instant feedback.

**Scene type fields** (from `src/lib/ai/scene-analysis.schema.ts`):

| Field            | Added By | Notes                                                                      |
| ---------------- | -------- | -------------------------------------------------------------------------- |
| `sceneId`        | Phase 1  | Required, unique                                                           |
| `sceneNumber`    | Phase 1  | Required, 1-indexed                                                        |
| `originalScript` | Phase 1  | `{ extract, dialogue }`                                                    |
| `metadata`       | Phase 1  | `{ title, durationSeconds, location, timeOfDay, storyBeat }`               |
| `continuity`     | Phase 1  | `{ characterTags, environmentTag, colorPalette, lightingSetup, styleTag }` |
| `prompts.visual` | Phase 3  | `{ fullPrompt, negativePrompt }` — `components` is no longer LLM output    |
| `prompts.motion` | Phase 4  | `{ fullPrompt }` — `components`/`parameters` are no longer LLM output      |
| `musicDesign`    | Phase 4  | `{ presence, style, mood, atmosphere }`                                    |
| `sourceImageUrl` | Optional | URL of generated or uploaded source image                                  |

## Real-Time Events

Events emitted via Upstash Realtime on a per-sequence channel (`getGenerationChannel(sequenceId)`).

| Event                                 | When Emitted                                      | Payload                                                               |
| ------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------- |
| `generation.phase:start`              | Before each LLM call or generation phase          | `{ phase, phaseName }`                                                |
| `generation.phase:complete`           | After each phase completes                        | `{ phase }`                                                           |
| `generation.poster:ready`             | Storyboard workflow — after poster generated      | `{ posterUrl }`                                                       |
| `generation.scene:new`                | Phase 1 — progressively as scenes stream in       | `{ sceneId, sceneNumber, title, scriptExtract, durationSeconds }`     |
| `generation.scene:updated`            | Phase 1 — as scene metadata updates during stream | `{ sceneId, sceneNumber, title, scriptExtract, durationSeconds }`     |
| `generation.updated`                  | Phase 1 — after title detected in stream          | `{ title }`                                                           |
| `generation.shot:created`             | Phase 1 — progressively as shots are upserted     | `{ shotId, sceneId, orderIndex }`                                     |
| `generation.frame:updated`            | Phase 4 — after prompts written to DB             | `{ frameId, updateType, metadata }`                                   |
| `generation.talent:matched`           | Phase 2 — when talent matched to characters       | `{ matches: [{ characterId, characterName, talentId, talentName }] }` |
| `generation.talent:unmatched`         | Phase 2 — unused talent after matching            | `{ unusedTalentIds, unusedTalentNames }`                              |
| `generation.location:matched`         | Phase 2 — when locations matched to library       | `{ matches: [{ locationId, locationName, libraryLocationId, ... }] }` |
| `generation.image:progress`           | Image workflow — generating/completed/failed      | `{ frameId, status, thumbnailUrl? }`                                  |
| `generation.variant-image:progress`   | Variant workflow — generating/completed/failed    | `{ frameId, status, variantImageUrl? }`                               |
| `generation.video:progress`           | Motion workflow — generating/completed/failed     | `{ frameId, status, videoUrl? }`                                      |
| `generation.audio:progress`           | Music workflow — generating/completed/failed      | `{ status, audioUrl? }`                                               |
| `generation.character-sheet:progress` | Character bible — per character                   | `{ characterId, status, sheetImageUrl? }`                             |
| `generation.location-sheet:progress`  | Location bible — per location                     | `{ locationId, status, referenceImageUrl? }`                          |
| `generation.recast:start`             | Recast character — before regenerating frames     | `{ characterId, frameCount }`                                         |
| `generation.recast:complete`          | Recast character — all frames regenerated         | `{ characterId, successCount, failedCount }`                          |
| `generation.recast:failed`            | Recast character — on failure                     | `{ characterId, error }`                                              |
| `generation.recast-location:start`    | Recast location — before regenerating frames      | `{ locationId, frameCount }`                                          |
| `generation.recast-location:complete` | Recast location — all frames regenerated          | `{ locationId, successCount, failedCount }`                           |
| `generation.recast-location:failed`   | Recast location — on failure                      | `{ locationId, error }`                                               |
| `generation.error`                    | On non-fatal workflow error                       | `{ message, phase? }`                                                 |
| `generation.failed`                   | On workflow failure                               | `{ message }`                                                         |
| `generation.complete`                 | Storyboard workflow — after everything finishes   | `{ sequenceId }`                                                      |

## Error Handling

### Failure Handling (`onFailure`)

Every workflow extends `OpenStoryWorkflowEntrypoint` (`src/lib/workflow/base-workflow.ts`), which wraps the workflow body: when `runImpl` throws, the base class builds a `ScopedDb` from the payload and invokes the subclass-supplied `onFailure({ event, error, scopedDb })`. The analyze-script `onFailure`:

1. Sanitizes the error via `sanitizeFailResponse()` — extracts inner errors from nested failure wrappers, maps known Cloudflare error codes (e.g., `1102` → "Worker exceeded memory limit"), and truncates messages over 500 characters
2. Updates sequence status to `'failed'` with the error message
3. Emits `generation.failed` with the sanitized error

> The base class deliberately skips `onFailure` when the engine aborts mid-run (a transient state the instance resumes from), so it doesn't mark user-facing rows failed for a retry that will succeed.

Child workflows (image, motion, music, character bible, location bible, talent matching, location matching, frame-images, motion-batch) each implement their own `onFailure` that updates the relevant record's status to `'failed'`.

### Retry Strategy

Under Cloudflare Workflows, retries are configured per `step.do()` (and on the workflow class), not on the trigger — the legacy `retries`/`retryDelay` options on `triggerWorkflow()` are accepted for back-compat but are **no-ops**.

| Level                                  | Retries         | Backoff                                                   |
| -------------------------------------- | --------------- | --------------------------------------------------------- |
| Individual `step.do()` steps           | engine default  | Managed by the Workflows engine                           |
| LLM-call steps (`durableLLMCallCf`)    | via `step.do`   | Engine-managed                                            |
| Child workflows (`spawnAndAwaitChild`) | own step budget | Awaited with a `timeout`; the child retries its own steps |

Per-scene fan-out (image, variant, motion) uses `Promise.allSettled` over `spawnAndAwaitChild`, so one scene's failure or timeout doesn't kill the rest of the batch — failures are collected and surfaced as a single error.

### Cloudflare Workflows Durability

- Each `step.do()` step is checkpointed by the Workflows engine. The workflow body **replays from the top** on every step callback; already-completed steps return their persisted result instead of re-executing, so on failure or restart execution effectively resumes from the last completed step. (This is why steps must be idempotent and why large blobs shouldn't be returned across a step boundary.)
- `spawnAndAwaitChild()` starts a child workflow instance (its own `binding.create()`) and awaits its result via a wake event (`waitForEvent`). The child is durable independently of the parent.
- No application-level concurrency gating — fal queues submissions server-side (`IN_QUEUE` doesn't count toward the cap, jobs are never rejected), and OpenRouter handles its own rate limits. (A past QStash-era attempt at gating via `flowControl` produced ghost slot leaks on cancel and PR-preview cross-contamination; see #725. Cloudflare Workflows likewise has no app-level gate.)

## Key Files Reference

| File                                                 | Purpose                                                             |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `src/functions/sequences.ts`                         | Server functions that trigger the pipeline                          |
| `src/lib/workflow/client.ts`                         | `triggerWorkflow()` — resolves binding + `binding.create()`         |
| `src/lib/workflow/trigger-bindings.ts`               | `TRIGGER_TO_BINDING` — maps trigger path → Workflows binding        |
| `src/lib/workflow/base-workflow.ts`                  | `OpenStoryWorkflowEntrypoint` — base class, `onFailure`, `ScopedDb` |
| `src/lib/workflow/await-child.ts`                    | `spawnAndAwaitChild()` — parent→child fan-out + await               |
| `src/lib/workflows/llm-call-helper.ts`               | `durableLLMCallCf` / `durableStreamingLLMCallCf`                    |
| `src/lib/workflows/storyboard-workflow.ts`           | Wrapper: verify, clear, poster, spawn analyze-script                |
| `src/lib/workflows/analyze-script-workflow.ts`       | Core orchestration (phases 1-5)                                     |
| `src/lib/workflows/scene-split-workflow.ts`          | Phase 1: two parallel LLM calls, boundary split + preview images    |
| `src/lib/ai/boundary-split.ts`                       | Anchor resolution + verbatim script slicing                         |
| `src/lib/ai/tag-reconcile.ts`                        | Canonicalize scene continuity tags onto bible tags after the join   |
| `src/lib/ai/streaming-scene-parser.ts`               | Incremental JSON parser for the boundary-annotation stream          |
| `src/lib/workflow/sanitize-fail-response.ts`         | Error message extraction + Cloudflare error-code mapping            |
| `src/lib/db/helpers/frames.ts`                       | `upsertFrame()` / `bulkInsertFrames()` idempotent helpers           |
| **Extraction + Matching**                            |                                                                     |
| `src/lib/workflows/talent-matching-workflow.ts`      | Talent matching against Phase 1 character bible                     |
| `src/lib/workflows/location-matching-workflow.ts`    | Location matching against Phase 1 location bible                    |
| **Reference Generation**                             |                                                                     |
| `src/lib/workflows/character-bible-workflow.ts`      | Character sheet generation (parallel per character)                 |
| `src/lib/workflows/character-sheet-workflow.ts`      | Single character sheet image generation                             |
| `src/lib/workflows/location-bible-workflow.ts`       | Location sheet generation (parallel per location)                   |
| `src/lib/workflows/location-sheet-workflow.ts`       | Single location reference image generation                          |
| **Prompt Generation**                                |                                                                     |
| `src/lib/workflows/visual-prompt-workflow.ts`        | Visual prompt sub-workflow (parallel per scene)                     |
| `src/lib/workflows/visual-prompt-scene-workflow.ts`  | Per-scene visual prompt LLM call                                    |
| `src/lib/workflows/motion-prompt-workflow.ts`        | Motion prompt sub-workflow (parallel per scene)                     |
| `src/lib/workflows/motion-prompt-scene-workflow.ts`  | Per-scene motion prompt LLM call                                    |
| `src/lib/workflows/motion-music-prompts-workflow.ts` | Orchestrates motion + music prompts in parallel                     |
| `src/lib/workflows/music-prompt-workflow.ts`         | Music design LLM call                                               |
| **Image Generation**                                 |                                                                     |
| `src/lib/workflows/frame-images-workflow.ts`         | Orchestrates image + variant gen for all scenes                     |
| `src/lib/workflows/image-workflow.ts`                | Single image generation (Fal.ai)                                    |
| `src/lib/workflows/variant-workflow.ts`              | Shot grid variant generation                                        |
| **Motion + Music Generation**                        |                                                                     |
| `src/lib/workflows/motion-batch-workflow.ts`         | Orchestrates motion + music + merge                                 |
| `src/lib/workflows/motion-workflow.ts`               | Single motion/video generation (Fal.ai)                             |
| `src/lib/workflows/music-workflow.ts`                | Music generation (Fal.ai)                                           |
| `src/lib/workflows/merge-video-workflow.ts`          | Merge frame videos into sequence video                              |
| `src/lib/workflows/merge-audio-video-workflow.ts`    | Merge music audio with video                                        |
| **Recasting + Regeneration**                         |                                                                     |
| `src/lib/workflows/recast-character-workflow.ts`     | Recast a character and regenerate affected frames                   |
| `src/lib/workflows/recast-location-workflow.ts`      | Recast a location and regenerate affected frames                    |
| `src/lib/workflows/regenerate-frames-workflow.ts`    | Regenerate specific frames with new prompts                         |
| **Schemas + Events**                                 |                                                                     |
| `src/lib/realtime/index.ts`                          | Real-time event schema and channel helpers                          |
| `src/lib/ai/scene-analysis.schema.ts`                | `Scene` type definition                                             |
| `src/lib/ai/response-schemas.ts`                     | `musicDesignResultSchema` and other LLM response schemas            |
