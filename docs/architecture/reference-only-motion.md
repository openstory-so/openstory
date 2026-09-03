# Reference-only motion

A reference-only shot renders straight to video from the character, location
and element reference sheets plus a self-describing motion prompt, on a route
whose start frame is optional — no still is generated for it.

The default pipeline is image-to-video: an image model renders a still, and a
video model animates it. Reference-only removes the still. That is one deleted
phase and one inverted assumption — and the inverted assumption is the whole
substance of the feature.

`sequences.generateStartFrames` sets the default for a sequence (off, the
default, is reference-only); `shots.useStartFrame` overrides it per shot (NULL =
inherit). Resolve with `usesStartFrame()` /
`rendersReferenceOnly()` — never read either column raw. See "Per shot, not per
sequence" below.

## Why the motion prompt has to change

The image-to-video motion prompt exists to animate a picture the model can
already see. Its central rule says so:

> **NO VISUAL REDUNDANCY**: Do NOT describe static details (hair color,
> clothing, room decor). The video model already sees these in the starting
> frame. Only describe what MOVES or CHANGES.

Take away the still and that instruction inverts. Nothing has been seen, so
every visual decision the prompt declines to make, the model makes instead —
and it makes a _different_ one on the next shot. A sequence written that way
loses its set, its light and its framing between every cut.

So reference-only uses a separate template
(`phase/motion-prompt-reference-only-chat`) that asks for the still's job and
the motion's job in one prompt:

1. **Shot size and lens feel** — the framing at the instant the shot opens.
2. **Blocking** — where each named character is, facing where, touching what,
   stated as a fact about the opening frame rather than an outcome.
3. **The set** — surfaces, depth and two or three specific on-camera objects,
   drawn from the location bible.
4. **Light** — direction, quality, colour temperature, practical source.
5. **Look** — medium, palette and grade from the style config.
6. **Prop state** — pinned at the top, because video models do not reason
   backward from an outcome. "She slides under the closing gate" does not
   guarantee the gate is still open when she arrives.

Then the same motion discipline as its sibling: one camera move, camera and
subject motion in separate sentences, one physics event, one continuous take.

Two templates rather than one template with a conditional block. They disagree
on their most load-bearing rule, and a prompt that hedges between them gets
both half-right. `src/lib/prompts/motion-prompt-templates.test.ts` pins the
disagreement so a future edit cannot quietly merge them.

### What it must still NOT describe

Identity. Face, hair, skin, build, age, ethnicity and default costume come from
the bound reference sheet, and prose describing the same person competes with
the sheet and drifts the likeness. (It is also what trips real-person likeness
moderation on some providers — see `reference-image-prompt.ts`.) Wardrobe is
mentioned only where the scene changes it. The line the template draws:
**describe the SHOT, never the PEOPLE.**

### Bibles

The reference-only template is given `<LOCATION_BIBLE>` and `<ELEMENT_BIBLE>`.
The image-to-video template computes both and interpolates neither — a
long-standing quiet bug, survivable there because the still had already
resolved the set. Here there is no such backstop.

## Pipeline changes

`AnalyzeScriptWorkflow` phase 4 skips the shot-images child entirely and drops
the `imageUrls.some(url => url !== null)` gate that guards phase 5.

**Phase 3 skips the visual prompts too.** They looked cheap enough to keep — a
mode-switch cache, and staging for the motion prompt to open on. The second
half was wrong: the reference-only template is never handed the visual prompt.
Its inputs are `<CURRENT_SCENE>` (the `Scene` JSON, whose `prompts` field was
removed in #713), the three bibles, `<DIRECTOR_STYLE>` and `<ASPECT_RATIO>` —
it composes the opening frame from the bibles itself, which is the reason it is
a separate template at all. Nothing else read them: no still is rendered from
them, and the only live consumer was the music prompt's visual grounding, which
falls back to `scene.metadata`. So it was one LLM call per scene for a cache.
`visualPromptsBySceneId` comes back empty and the motion-prompt hash is
unaffected (it never included the visual prompt).

The anchor frame and the per-scene **storyboard preview still are kept**. The
preview is what fills the scene rail while the clip renders — without it the
rail has nothing to show until the video lands, and the anchor frame is where
that preview variant hangs.

**The motion/music prompts run as part of phase 3, next to the sheets.** Phase
3 produces sheets — images — and the prompt child reads bible TEXT: the bibles
come from scene-split, casting resolves at the end of phase 2, and there are no
visual prompts to wait on. The one real dependency in the image path is the
rendered still (#929 conditions the motion prompt on it as vision input), and
there is no still here.

**So reference-only has no phase 4.** With the stills skipped and the prompts
already settled, nothing is left for it to do but wait — and it does not even
do that, since phase 3 awaits the prompts itself. The workflow emits no
phase-4 event and `createInitialState` filters the chip out
(`REFERENCE_ONLY_SKIPPED_PHASE`), so the rail runs **Script → Casting →
References → Music & Motion**. Phase numbers keep their identity across the
gap: `PHASE_START` for 5 marks every lower phase complete, so a missing 4
changes nothing. Phase 3's existing label, "References & prompts", describes
the merged step exactly.

## The reservation gate

`grow-reservation` runs **after casting, before phase 3** — it used to sit
after phase 3. Both positions are valid readings of the same comparison:

```ts
if (remainingWork <= peek.remaining) return { spawnRenders: true };
```

`peek.remaining` is a live balance. Downstream of phase 3 it has already lost
the sheet spend, which is why `estimateStoryboardRenderCost` documents itself
as excluding sheets — "those already ran". Upstream, that money is still in the
reservation, so the sheet cost has to be added back or the gate over-approves
and the board runs out mid-render.

Adding it back is what `estimateReferenceSheetCost` is for, and moving up buys
two things. A credits-short run now fails in seconds instead of after a full
set of sheets is paid for. And the counts stop being guesses: pre-flight only
has a script, so it uses the `estimate*SheetCount(sceneCount)` heuristics
(capped at 3), while the in-run gate knows the bibles and the casting result —
one sheet per bible entry, minus the characters whose matched talent sheet is
reused. That reuse test is `reusesTalentSheet`, shared with
`character-bible-workflow` so the gate cannot count a sheet the run does not
generate; a reused sheet is a storage copy with no provider cost. Every
location is billed either way — a library match supplies a reference image, but
the styled sheet is still generated.

`MotionPromptBatchWorkflow`'s "refusing to generate an unanchored motion
prompt" guard is lifted, since in this mode a missing still is the design
rather than a failed image.

`buildMotionReferenceImages` gains the scene's location sheet, ordered first.
The image-to-video path deliberately excludes locations (#873): the still
already fixes the environment, so a location sheet only competes for reference
slots. Reference-only has no still, which makes that sheet the only thing
standing between the prompt's words and an invented set. It leads because the
reference budget is spent in order — a scene with a big cast should lose a bit
player before it loses its set.

## Rendering

`resolveMotionEndpoint(model, hasRefs, via, referenceOnly)`:

- Forces the reference route even when a scene matched no sheets at all. A
  two-hander in an unmatched location still needs an endpoint whose start frame
  is optional.
- Throws for a model with no such route rather than submitting a request the
  endpoint must reject.

`buildReferenceVideoPrompt` drops the `Use @Image1 as the starting frame.` line
and binds references from slot 1. Pointing the model at `@Image1` when
`@Image1` is a character sheet makes it open on the sheet — flat lighting and
all. The whole `maxImages` budget goes to references.

**BytePlus Ark** switches `size` from `adaptive_720p` to the sequence's own
ratio. `adaptive` means "follow the frame", and there is no frame role in the
request; Ark would size the clip from the first reference, so a portrait
character sheet would silently render a 9:16 clip into a 16:9 sequence.

Billing prices the reference-to-video endpoint the job actually hits, not the
image-to-video row — the post-hoc charge (`motionCostFromUsage`), the workflow
estimate (`calculateMotionMetadata`), AND the pre-flight credit gates, which
take `referenceOnly` through `estimateVideoCost`. A reference-only shot routes
to r2v even having matched no sheets at all, so resolving on `hasReferenceImages`
alone under-prices exactly the shots with the least to go on.

`video_variants.manifest` records `frameVersionId: null` — the documented
encoding of "reference-driven shot with no dedicated first frame". Every write
path uses it (single-shot, batch, smart-retry, update-stale) and every
comparison expects it, including `isSelectedVersionStale` via
`SegmentShotInput.rendersReferenceOnly`. A path that recorded the still it did
not use marked its own clip Stale the instant it finished.

That null is not the record of the mode, though. It is overloaded: it also
means "frame not pinned" (#1380) and, beside a null prompt id, "legacy row,
unknown provenance". So every manifest entry also carries a **required**
`usesStartFrame` — stamped, not derived, for the same reason
`video_variants.resolution` is: the shot's switch can flip after the render,
and a clip has to be able to say how it was made. Rows written before the
stamp were backfilled by migration
`20260902235958_backfill_manifest_uses_start_frame` from the shot's mode at
that moment (reference-only ships in the same release, so nothing had
flipped). Staleness still compares pointers as above; the stamp exists so the
row is legible on its own.

The motion prompt gets the same stamp. `shot_prompt_versions.usesStartFrame`
records which template authored the text: the two templates disagree on their
central rule, so a prompt is only correct in the mode it was written for, and
`inputHash` folds the mode in but cannot be read back. Every write input
requires it (`write`, `writeAiVersion`, `createPending`,
`completePendingAiVersion`); a restore copies its source row's. The column is
NOT NULL with a SQL default of true, which is only ever exercised by rows that
predate reference-only and so were image-to-video.

## Model gating

Only models in `MOTION_REFERENCE_ENDPOINTS` qualify — today Seedance 2.0 and
2.5 and MiniMax H3 Max, whose `reference-to-video` route requires only a
prompt and takes its images in `reference_image_urls` rather than `image_urls`
(`imageField` on the endpoint config; every builder reads it, so a fourth model
with a fourth field name needs no code).
`supportsReferenceOnlyMotion` is keyed on the MODEL, not the resolved via — the
conservative floor, safe in a pure isomorphic schema. It is NOT the question to
ask anywhere a team's keys are reachable; see below.

Kling is excluded — its `elements` ride on the image-to-video endpoint, which
requires `image_url`.

**Grok Imagine 1.5 is not excluded because it lacks references — it has them.**
`GROK_VIDEO_REFERENCE_CONFIG` binds up to 7, `resolveMotionEndpoint` returns
`inline` for it, and `buildGrokVideoRequest` handles the no-still case. What it
lacks is a _route_: its catalog id is
`xai/grok-imagine-video/v1.5/image-to-video`, so only the native **xAI** via can
serve a reference-only shot, and the via is claimed per team at submit time
(team `xai` key → platform `XAI_API_KEY` → fal). A creation-time gate cannot
know which way a given team will resolve months later, so it stays conservative.

Where the via IS known, ask the honest question instead:
`canRenderReferenceOnly(model, scopedDb)` in `motion-generation.ts` returns true
for Grok whenever an xAI key resolves. `MotionWorkflow`'s entry guard and the
content-flag rescue both use it, which is what lets Grok rescue a flagged
reference-only shot rather than committing itself onto the row and then dying.

Grok IS selectable at creation. `getViaAvailabilityFn` resolves the team's
reachable vias server-side, the `_app` loader seeds it, and the model selectors
filter on the `referenceOnlyModels` it returns. The isomorphic schema asks the
widest question (`referenceOnlyCapableWith(model, { xai: true })`) and
`createSequences` re-asks against real keys.

**Ask `canRenderReferenceOnly` wherever keys are reachable** — creation, the
workflow, and both regenerate paths in `motion-functions.ts`. Asking the
model-only question in a server fn rejected regeneration on Grok sequences that
same code had already created and rendered.

`createSequenceSchema` validates **every** selected video model, not just the
primary: reference-only renders each of them, and a variant without a reference
route would fail every shot it was asked to render. The motion model selectors
filter to capable models when the toggle is on, and flipping it on drops an
incompatible selection — so a user cannot build a selection the server rejects.

## Staleness

The mode joins the motion-prompt input hash, but **only when true**, so every
stored image-to-video digest is unchanged and no `PROMPT_INPUT_HASH_VERSION`
bump or null-sweep migration is needed (the same shape-stable trick
`styleConfigHashBody` uses for its optional refinements). Flipping the mode
re-stales the motion prompts rather than silently mixing two prompt styles.

`referenceOnly` is **required**, not optional, on `ShotPromptContextSequence`.
The failure mode of omitting it is silent and permanent: the stamp would fold
the flag in and the verify would not, so every reference-only motion prompt
would read stale forever. Making it required turns that into a compile error at
each call site. Per-shot call sites must pass the RESOLVED value
(`shotPromptSequence` / `rendersReferenceOnly`), not the raw sequence column —
`reference-only-is-per-shot.test.ts` fails a path that reads it raw.

The visual-prompt hash ignores it. The visual prompt produces the still; it
cannot depend on whether one gets rendered.

## Per shot, not per sequence

`sequences.generateStartFrames` is the sequence default (off = reference-only,
which is what a new sequence gets); `shots.useStartFrame` overrides it (NULL =
inherit). It replaced an inverted `referenceOnly` column so the sequence default
speaks the same language as the shot override. The resolution lives in one place —
`usesStartFrame(shot, sequence)` / its inverse `rendersReferenceOnly` — and
`reference-only-is-per-shot.test.ts` fails any per-shot path that reads
`sequence.generateStartFrames` raw. Nine call sites have to agree; they drifted
once already.

The switch is **not** render-only. It picks the motion-prompt template and
folds into the motion-prompt hash, so flipping it re-stales that shot's motion
prompt — deliberately, because rendering a reference-only shot with an
image-to-video prompt reinvents the composition the prompt never described.

Both directions are gated at `setShotUseStartFrameFn`, because either can
persist a shot that cannot render: ON needs an existing still (a checkbox must
never start image generation and spend money), OFF needs a model with a
reference-to-video route. Ungated, one unrenderable shot rejected the whole
sequence's batch motion.

Consequences of the override being per shot:

- **Eligibility** (`isBatchMotionEligible`) takes the resolved value, or a
  reference-only shot is filtered out for having no still.
- **Pricing** takes a per-shot predicate. A mixed batch priced on one shot's
  answer quotes the wrong endpoint for the rest.
- **The manifest** records `frameVersionId: null` for a reference-only shot
  even when a still exists, and staleness compares against the same rule.
- **`UpdateStalePlan`** freezes `usesStartFrame` per target at click time. It
  is required and never defaulted: a payload from a build that predates it
  replays without the key, and `!undefined` is `true`, which would silently
  re-render every clip in the run with no start frame.

## Trade-offs

Reference-only is faster and cheaper — one generation per shot instead of two.
What it gives up is control: with a still you can look at the composition,
regenerate it, upscale it, or hand-pick a variant before any video spend. Here
the first thing you see is the clip. It also narrows the usable motion models
to those with a reference-to-video route. It is the default even so: most shots
never need a hand-picked still, and "Generate start frames" in the options opts
a sequence back into the frame-based workflow. Every sequence and shot that
existed before the default flipped was stamped onto start frames by migration
`20260903000946_backfill_generate_start_frames`, so the flip changed nothing
already made.
