# Reference-only motion

A reference-only sequence never generates start frames. Each shot renders
straight to video from the character, location and element reference sheets
plus a self-describing motion prompt, on a route whose start frame is optional.

The default pipeline is image-to-video: an image model renders a still, and a
video model animates it. Reference-only removes the still. That is one deleted
phase and one inverted assumption — and the inverted assumption is the whole
substance of the feature.

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
the `imageUrls.some(url => url !== null)` gate that guards phase 5. Visual
prompts are still written in phase 3: they are cheap text, they carry staging
the reference-only prompt opens on (threaded down as `visualPrompt`), and
keeping them means toggling the mode off does not have to re-derive them.

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

`video_variants.manifest` records `frameVersionId: null`, which is already the
documented encoding of "reference-driven shot with no dedicated first frame".

## Model gating

Only models in `MOTION_REFERENCE_ENDPOINTS` qualify — today Seedance 2.0 and
2.5. `supportsReferenceOnlyMotion` is keyed on the MODEL, not the resolved via:
the mode is chosen at sequence creation while the via is claimed per team at
submit time, so a model that is capable on one via and not another could not be
gated honestly.

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

Making Grok _selectable_ at creation is a separate decision: it needs a
server-side "is xAI configured" signal reaching both the schema refine and the
model selector, which `createSequenceSchema` (isomorphic, pure) does not have
today.

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
each call site. It is read off the sequence row rather than passed as a
separate argument, so a caller that already loads a sequence carries it without
opting in.

The visual-prompt hash ignores it. The visual prompt produces the still; it
cannot depend on whether one gets rendered.

## Trade-offs

Reference-only is faster and cheaper — one generation per shot instead of two.
What it gives up is control: with a still you can look at the composition,
regenerate it, upscale it, or hand-pick a variant before any video spend. Here
the first thing you see is the clip. It also narrows the usable motion models
to the Seedance family. Off by default for both reasons.
