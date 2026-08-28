---
name: sd25-pe
description: Use when a user asks an Agent to optimize text, stories, or optional multimodal references for Seedance 2.5 text-to-video, multi-reference generation, keyframes, storyboards, blockouts, video editing, audio editing, or extension.
metadata:
  skill_version: 0.1.1
  owner: seedance
  tags:
    - seedance
    - prompt-optimization
    - multimodal-video
  supported_runtimes: []
  required_capabilities:
    filesystem_read: false
    filesystem_write: false
    tool_use: false
    network: false
    binary_outputs: false
  io_contract:
    output_kind: text
    primary_outputs:
      - optimized_prompt
  exports: []
---

# Seedance 2.5 Prompt Optimizer

## Self-update before triggering

The first time this Skill is triggered in each session, the Agent must run the following command first to refresh the local Skill copy to latest, and then proceed to "## Purpose" and all subsequent workflows. If this command has already been run earlier in the same session, regardless of whether it succeeded or failed and degraded gracefully, subsequent triggers in the same session do not need to repeat it and can proceed directly to the workflow. Count the first trigger again when a new session starts.

```bash
npx --yes skills@latest update sd25-pe -y
```

The command is fixed as shown above: write the Skill name as `sd25-pe`, and keep only the `-y` parameter so that the CLI automatically detects the global or project scope. Do not expand it into other subcommands such as `install` or `list`, and do not change or add any other parameters.

Use a best-effort execution strategy:

- **On success**: Silently proceed to the normal workflow. You do not need to report update details to the user.
- **On failure** (non-zero exit, timeout, offline environment, `npx` unavailable, package not found, and similar cases): Do not block the current task. First output this separate one-line notice to the user: `This run could not automatically update sd25-pe and will continue with the current local version.` Then continue through the remaining workflow. Never refuse to generate a Prompt just because the update failed.

This update command is a local Skill maintenance action. It is not a video generation API call prohibited by "Non-Negotiable Principles".

## Purpose

Compile the user's raw text, novel excerpts, and optional image, video, and audio references into one clean Prompt that can be submitted directly to Seedance 2.5. Preserve the user's core intent, and make asset roles, subject mappings, event states, and relationships that must remain consistent explicit.

This Skill's responsibility ends after it understands the input and outputs the Prompt; under no circumstances does it call a generation API on its own. When the user explicitly requests video generation, first use this Skill to produce a clean Prompt, then submit it through a separate generation tool or workflow. This Skill always treats assets as read-only, never modifies the original assets, and never creates auxiliary assets automatically.

## When to Use

Load this Skill in the following situations:

- The user asks to optimize, rewrite, or complete a Seedance 2.5 Prompt.
- The user provides a brief idea, a long narrative, a novel excerpt, or an unstructured complex Prompt.
- The user provides images, videos, audio, file paths, or a multimodal request that requires assigning asset roles.
- The user wants multi-asset generation, a long-form video, keyframe control, a storyboard grid, blockout rendering, video editing, audio editing, or video extension.
- The user wants to improve emotional performance, camera movement, sound, dialogue language, or the depiction of a product workflow.

Do not automatically run this Skill in the following situations:

- The user only asks about API parameters, pricing, quotas, errors, or model capabilities and does not need a Prompt.
- The user only asks for an evaluation of a generated video and does not request a Prompt rewrite.

When the user explicitly asks to generate a video directly, still use this Skill first to compile the original input into a clean Prompt, then pass it to the downstream generation workflow. This Skill does not submit the task itself.

## Non-Negotiable Principles

1. **Intent First**: Do not change character identities or counts, key props, scenes, event causality, spatial relationships, the editing target, the extension direction, or the story outcome.
2. **Template First**: Regardless of whether the original Prompt is complete, reorganize it using the template for the current task. Do not merely paraphrase it.
3. **Account for Every Asset**: State what is adopted from every asset that is actually used. Every asset that is available but has no assigned role must be listed individually under `【Unused Assets】` to prevent downstream prompt enhancement from reactivating it.
4. **User Mapping First**: Never override asset roles, subject names, or relationships explicitly specified by the user with automatic judgment. Once the corresponding slot is covered, do not add an unnamed asset merely to reinforce the same role.
5. **Minimal Clarification**: Resolve anything that can reasonably be determined from the text, assets, and context. Ask one consolidated question only when multiple equally valid interpretations would change the core result.
6. **Submission-Ready Content Only**: The Prompt must not contain the analysis process, evaluation notes, experiment groups, model versions, run markers, API keys, or reasons for changes.
7. **Separate Parameters**: Do not write aspect ratio, total duration, resolution, frame rate, or the sound toggle into the Prompt. Set these parameters on the page or through the API for regular generation tasks. For video editing, first-frame or first-and-last-frame generation, and video extension, follow the applicable automatic locking rules first. Time ranges originally written by the user are creative content; do not invent new numerical time ranges solely by working backward from a target duration specified on the page or through the API.
8. **Do Not Add Unrequested Constraints**: Do not automatically add quality packs, stability packs, watermarks, logos, subtitles, duplicates, or other generic negative constraints that the user did not request. A routing-disambiguation declaration added by the aspect ratio and duration compatibility gate is not a generic visual negative constraint, and it may be added only when that gate is triggered.
9. **One Best Version**: By default, output only the single Prompt judged to be the best fit. Output multiple versions only when the user explicitly requests a comparison.
10. **Separate Facts from Observations**: Take character identity, age, relationships, events, and outcomes from the user's text. Use assets only to add directly visible or audible attributes, and never elevate a visual guess into a story fact.
11. **Match Subject Cardinality**: A single-character reference image must not define two named characters who appear at the same time. When multiple usable single-character candidates exist, first assign one image per character; when multiple usable group candidates exist, first assign one image per group. Combine references only when they show multiple views of the same subject, or when the asset itself clearly contains the same story group.

## Input States

Determine which of the following states the input falls into before processing its content.

### Text-to-Video Only

The user provides no assets, and the text does not express a need to reference a particular person, product, scene, action, camera movement, or sound. Directly extract the subject, event, scene, visual treatment, camera, and sound, then apply the video generation template. Do not invent asset numbers or suggest that the user provide assets.

### References Needed but Assets Not Provided

Preserve every asset reference already written in the user's original Prompt exactly as provided, including `@ImageN`, `@VideoN`, `@AudioN`, or equivalent labels in the runtime environment. Do not delete them, renumber them, or rewrite the request as generation without references. The fact that the corresponding assets are not attached to the current message or cannot be read by the current Agent must not alter the reference relationships.

Continue optimizing the Prompt normally from the user's original text while preserving its task organization, asset roles, and reference relationships. Do not claim to have inspected the assets, and do not add details that could only be confirmed by inspecting them. If the user did not write any asset references, do not invent them.

Assets that are not attached or cannot be read only limit which facts can be confirmed; they do not block Prompt optimization or trigger an out-of-Prompt warning about missing assets or a suggestion to provide them. Still evaluate aspect ratio and duration intent using the “Aspect Ratio and Duration Compatibility Gate.”

### Assets Are Readable

Actively inspect the images, videos, and audio provided by the user. Inventory all assets first, then map them in conjunction with the Prompt. Do not guess from filenames alone, and do not force every asset into the Prompt.

### Current Agent Cannot Read the Assets

If the user provides an attachment, path, or URL that the current runtime cannot access, continue optimizing according to “References Needed but Assets Not Provided”: preserve the user's existing asset references, use only information that can be confirmed from the text, do not pretend to have inspected the assets, and do not append a missing-asset warning or a suggestion to provide them.

For damaged or unreadable assets, likewise preserve any reference relationships already written by the user. Do not infer appearance, voice, or content from a filename, path, or URL.

### Asset Specification Preflight

First distinguish hard input limits from stability recommendations:

- Up to 30 images, with each image no larger than 4K.
- Up to 10 videos, with a combined duration of no more than 30 seconds.
- Up to 10 audio clips, with a combined duration of no more than 30 seconds.
- Up to 50 total reference assets across images, videos, and audio.

Recommended ranges are not hard limits. Subject images generally work best with 1 to 8 subjects; subject audio and video generally work best with 1 to 5 subjects and clips of 5 to 10 seconds each; video editing generally works best with an original video of no more than 20 seconds and 1 to 5 reference images. If the input exceeds the recommended range but remains within the hard input limits, continue optimizing rather than blocking because there are many assets. Reduce cross-contamination by assigning a role to every asset, mapping each subject, and activating assets by scene.

When the input exceeds the hard limits, prioritize assets explicitly specified by the user, assets needed to cover required entities, the unique editing master or extension source video, and key action, sound, and boundary-frame assets. Leave all other assets out of the Prompt, then add one `Asset Note:` after the main body explaining that the asset set must be reduced before submission. Do not claim that the input limits can be bypassed through Prompt wording alone.

## Core Workflow

### 1. Parse the User's Goal

Build a “story contract” from the user's text before inspecting the assets. Extract and lock:

- Subjects and their counts.
- Actions, events, and causal sequence.
- Scene, time, weather, and spatial relationships.
- Prop ownership, transfers, and final states.
- Visual style, camera, sound, dialogue, and subtitle requirements.
- Content the user explicitly requires to preserve or exclude.
- Whether the task is generation, editing, or extension; whether a generation task uses keyframes, a storyboard grid, or a blockout; and whether an editing task modifies only sound.

The story contract defines the factual boundary for all later rewriting. Do not replace, merge, or remove characters or events from the story contract merely because a more visually prominent person, outfit, prop, or scene appears in an asset.

Preserve the semantics of the user's notation. Forms such as `Shot #45`, `Shot No. 45`, and `Shot 45` indicate a shot number by default, not a `45-degree camera angle`. Interpret a number as a camera angle only when the user explicitly writes “45 degrees” or an equivalent photographic angle. Do not rewrite shot numbers, asset numbers, chapter numbers, or step numbers as camera parameters.

Whenever the input includes speech, dialogue, narration, or an audio role, create an internal “dialogue ledger” for every time segment. Record the speaker, whether that person speaks, the exact dialogue, the audio role, the language, and whether the voice is on-screen or off-screen. Do not turn a segment with specified speech or an audio role into silence, and do not swap speakers or audio. If the user explicitly asks a character to speak with assigned audio but provides no dialogue text, or if the current environment cannot transcribe it reliably, preserve that character's role of speaking with the corresponding audio and do not invent specific dialogue.

When the user provides only a quoted dialogue fragment, keyword, or short phrase, treat only that fragment as the exact words that may be spoken. You may add the speaker's expression, actions, and delivery, but do not invent a complete sentence around the fragment. When the user describes only a speaking intention such as “use status to pressure the other person” or “continue arguing” without providing any exact words, do not invent dialogue. Express the intention through observable lip movement, pauses, posture, and the other person's reaction instead.

For example, if the input only says that she should convey status-based pressure when saying “You're an outsider,” the final dialogue may only be `{You're an outsider}`. Do not splice narrative explanations such as “mother-son relationship” or “status-based pressure” into the dialogue, and do not rewrite it as “You're an outsider. What right do you have...” or any other complete sentence.

Create a “required entity list” for the story contract, with a separate slot for every explicitly mentioned person, group, key prop, and scene. Use this list only for internal checks; do not output it to the user. Later, record each slot's narrative role, adopted asset, and observable features, then confirm before output that every slot appears in the Prompt.

Convert internal thoughts into visible actions, expressions, dialogue, or narration, but do not add events that change the story.

For a causal reveal shot in which a character changes expression or behavior only after the cause appears, show the trigger clearly before showing the character's reaction. When the cause and reaction are far apart, establish their relationship with one explicit eyeline or camera shift. When they can share the frame, keep the cause and reaction visible within the same composition. Do not push into a face-only close-up before the audience can clearly see the trigger, and do not show only the reaction close-up while omitting the trigger.

When the story explicitly involves pretending to be injured, simulating an injury, or nearly being injured, clearly preserve an observable uninjured state in any potentially ambiguous shot; for example, keep skin, clothing, and props intact. Do not rewrite a performance or an event that did not occur as a real wound, bleeding, or damage.

### 2. Compile Novels and Long Text

First convert the text into filmable events:

- When the user requests a trailer, overview, or ensemble presentation, choose a montage structure that summarizes the theme.
- When the user requests one scene, preserve the core events that occur continuously within that scene.
- When the user does not specify a scope, choose one causally complete primary event that can work within the target video, and briefly explain the selection outside the Prompt.
- Ask one consolidated question only when multiple mutually exclusive main storylines are equally important and choosing among them would change the core story.

Compress repetitive description and information that cannot be visualized, while preserving character relationships, key dialogue, trigger events, and the ending state.

### 3. Inventory and Understand the Assets

When there are many assets, inspect them in two passes:

1. In the first pass, lightly inventory all assets and identify candidates for people, products, props, scenes, actions, camera movement, pacing, sound, and style.
2. In the second pass, inspect in depth only the assets that match the story, conflict with it, serve as keyframes, or will be used by the current scene.

When inspecting a video, confirm at least the subjects, principal actions, shot changes, start state, and end state. When inspecting audio, confirm at least the sound type, voice quality, language, dialogue content, or intended use as ambient sound.

Distinguish between two kinds of information:

- **Story Assignment**: A character's name, age, and relationships; which event they perform; who owns a prop; and how the story ends. These come from the user's text.
- **Asset Observation**: Facial features, hairstyle, clothing, material, color, spatial layout, actions, camera movement, voice quality, and other features that can be directly seen or heard.

Use assets only to add features that can be observed directly. Do not infer from an asset's appearance or rewrite identities, ages, relationships, or plot points stated in the text. Likewise, do not invent brands, colors, occupations, personalities, or prop functions that cannot be confirmed from the assets.

When the user refers only to a “person” or “subject,” keep that neutral term. Do not relabel the subject as a dancer, actor, worker, or any other identity based on actions, posture, or clothing. Continue using a character name or identity only when the user has provided it.

Forms of address, rank, occupation, and relationships define only narrative slots; do not automatically turn them into appearance or personality traits such as young, old, delicate, or commanding. Include such attributes only when the user's text states them explicitly or the corresponding expression is directly observable in the assets.

For a character asset, describe facial features, hairstyle, clothing, accessories, and directly observable posture by default. Do not replace visible details with summary labels such as “girlish,” “mature,” “delicate,” or “commanding.” When the user explicitly requests these performance directions, rewrite them as expressions, posture, and actions.

The mapping priority is fixed:

```text
User's explicit specification > Prompt description > Asset content > Filename and metadata > Upload order
```

When the user's explicit mapping already covers all required entities, do not activate other available assets that the user did not name. Do not add them as a second person, second scene, or auxiliary reference merely because their content is similar, and do not add unnamed assets to reinforce the same role. Generic background guests, furniture, decor, or environmental elements do not create an asset gap; cover them through the designated scene asset and the text description. Evaluate unnamed assets only when the user explicitly requests selection from all assets, asks to combine multiple references, or a core character, prop, scene, action, or sound explicitly required by the user still lacks a source. List every number that remains inactive by default under `【Unused Assets】` in the Prompt.

Upload order is not semantic evidence of identity or role and should generally be used only to establish stable numbering. Only when the user requests an immediate answer, the candidates are equally reasonable, and the number of slots equals the number of candidates may upload order be used as the final stable tie-breaker: assign candidates one-to-one by the order in which story slots first appear and by asset order. This ordering only makes the assignment deterministic; it does not prove true identity and must not be used to add unconfirmed age, relationships, or personality.

If the input is JSON or long text containing Asset IDs, create the `@ImageN`, `@VideoN`, and `@AudioN` mappings in the order each asset appears in the input, then replace Asset IDs in the text with the corresponding references. The final Prompt must not expose raw Asset IDs.

If there are only local paths and no reference labels, create stable aliases separately by media type and in the order provided by the user, then list each path and alias under “Asset Understanding.” Use those aliases in the final Prompt and remind the downstream workflow to preserve the same upload order.

### 4. Assign Asset Roles and Subject Mappings

Every used asset must have one explicit role:

- Images: character appearance and clothing, product structure and material, props, scene layout, lighting, or keyframes.
- Videos: action, camera movement, pacing, or timeline; or the unique editing master or extension source video.
- Audio: a designated speaker's voice and dialogue, ambient sound, sound effects, or music.

Before creating mappings, check every character, prop, and scene required by the story. Then perform the following steps in order:

1. Take each unassigned character, group, prop, and scene from the required entity list one by one.
2. Review all candidate assets and compare headcount, clothing hierarchy, silhouette, structure, props, and scene role. Do not stop searching after finding the first usable asset.
3. Select the best-matching asset for the current slot, then proceed to the next slot. Different named characters or groups should use different best candidates by default.
4. After mapping is complete, run an omission audit: every required entity must perform exactly one explicit role in the Prompt, and every activated asset must perform only its declared role.
5. Subtract the assigned assets from the complete list of available assets to obtain the unused set. Whenever this set is nonempty, add `【Unused Assets】` after the asset roles in the Prompt, list each unused number by media type, and explicitly state that the assets are not used for people, scenes, props, actions, camera, or sound. Do not explain this only outside the Prompt, and do not replace specific numbers with “other assets.”

Do not merge two named characters into one subject, and do not omit a character merely because that character's asset is less visually prominent. When distinguishable candidate assets are available, do not reuse one asset for multiple named characters or groups. Reuse is allowed only when the asset itself contains those characters together and no better independent candidates exist. When multiple assets jointly define the same entity, state this explicitly. Assets not called for by the story may be left unused.

In the final asset roles, each line must define only one subject, group, prop, or scene and its primary reference asset. Do not compress multiple subjects and assets into one range mapping, such as “Character A and Character B reference @Image1 and @Image2.” Split it into “Character A references @Image1” and “Character B references @Image2.”

If two core identities have no appearance clues in the text and the candidate assets are equally reasonable, do not pretend that a hidden answer can be inferred from the images. Ask one consolidated question according to “Handle Mapping Confidence.” If the user requests an immediate answer based on reasonable assumptions, use the stable tie-breaker above for a conservative one-to-one mapping and avoid adding unconfirmed distinctions such as age or personality.

When one subject has multiple references, state the view or attribute contributed by each asset and declare that they jointly define one entity rather than generating multiple copies.

Bind different subjects one by one, for example:

```text
<Character A> maps to @Image1; use only facial features, hairstyle, and clothing.
<Character B> maps to @Image2; use only facial features, hairstyle, and clothing.
<Prop A> maps to @Image3; use only structure, material, and color.
<Scene A> references @Image4; use only spatial layout, architecture, and lighting, and do not use the people in the image.

【Unused Assets】
@Image5 and @Image6 do not participate in this task and are not used for people, scenes, props, actions, or camera.
@Audio2 does not participate in this task and is not used for dialogue, voice quality, ambient sound, sound effects, or music.
```

Do not replace one-to-one mappings for multiple characters with a single range statement.

When the role of a reference video is unspecified, choose the dimensions relevant to the task from action, camera movement, pacing, scene, and sound. In a generation task, do not inherit character identity, clothing, or the entire scene from a reference video by default. When the reference video already provides the action, camera movement, and sequence accurately, state only which dimensions to inherit; there is no need to restate every action, as repetitive rewriting may conflict with the asset itself.

When written dialogue conflicts with the content of reference audio, use the user's text to determine the dialogue. By default, the audio provides only voice quality, accent, speaking rate, and emotion. The exception is when the user explicitly asks to reuse the dialogue in the audio.

When multiple references for the same subject conflict, follow the user's explicit specification first. If the user has not specified, assign appearance, clothing, structure, or material to the most suitable asset based on clarity and story fit. Clarify only when the core identity remains indeterminate.

### 5. Handle Mapping Confidence

- **High confidence**: Map automatically and continue.
- **Medium confidence**: Use the most reasonable mapping and disclose the key assumption outside the Prompt under “Asset Understanding.”
- **Low confidence, but no effect on the core result**: Do not use the asset and do not ask the user.
- **Low confidence, and affects core identity, count, prop ownership, front/back or left/right, facing direction, editing target, unique master, extension direction, or keyframe role**: Consolidate all related ambiguity into one brief question.

If an explicit user mapping clearly conflicts with the asset content, still follow the user's mapping. Confirm once only when the conflict is almost certain to produce an incorrect result.

Do not interrupt the user over missing style, lighting, routine camera movement, image quality, or anything else that can be resolved conservatively from context.

When clarification is necessary, ask only one consolidated question and stop to wait. Do not simultaneously output a provisional Prompt that might mislead downstream submission. Continue from mapping and task routing after the user responds. Only when the user explicitly requests a version based on reasonable assumptions may you proceed with assumptions and disclose them outside the Prompt.

If the user provides only assets without any generation, editing, or extension goal, ask once for the minimum creative objective. Do not invent a story from the asset content.

### 6. Select One Primary Task

#### Aspect Ratio and Duration Compatibility Gate

Run this gate proactively while parsing the user's original Prompt and before constructing any API request. Do not wait for an API error, and do not rely on `TaskTypeConstraint` before adding the declaration. First read the reference video's actual aspect ratio and duration, then compare them with the user's explicitly requested target output specifications:

- If the target aspect ratio differs from the reference video, do not classify the task as video editing; handle it as regular video generation.
- If the target duration differs from the reference video by more than approximately 0.3 seconds, do not classify the task as video editing. When the user explicitly asks to continue the video before or after the original, handle it as video extension; handle other duration changes as regular video generation.
- If a reference video has been provided but its specifications cannot be read, or the user asks to reference the original video without providing it, first determine the task from the explicit intent in the original Prompt. If the user clearly requests a relative change such as “landscape to portrait,” “portrait to landscape,” “shorten it to 8 seconds,” “change it to 20 seconds,” or “expand it to 20 seconds” without an extension direction, conservatively determine that there is an aspect ratio or target total duration conflict, avoid video editing, and handle the task as regular video generation. When the user provides only a target ratio or duration without expressing a relative change, do not claim that a conflict has been confirmed. Explicit extension intent such as “extend before,” “extend after,” or “continue” must still be handled as video extension.
- Classify the task as video editing only when the target aspect ratio and approximate duration match the reference video or are both unspecified, and the user asks to modify a specific object, region, or sound in the original video.

Verbs such as “convert,” “adjust,” “modify,” “change to,” and “reconstruct” do not by themselves constitute video editing. Do not trigger the declaration solely because the original Prompt uses words such as “convert,” “adjust,” “modify,” or “keep unchanged.” When incompatible specifications route the task to regular video generation, use the reference video only as a reference for content, characters, scenes, actions, timing, camera, and sound. Treat aspect ratio and total duration only as page or API parameters. Do not use phrases such as “edit,” “modify,” or “convert the original video” in the final Prompt, and do not promise exact frame-level or pixel-level consistency.

Only when the aspect ratio or duration conflict above is confirmed or conservatively determined may the optimized final Prompt proactively include this complete sentence: `Please note that this is not video editing.` In a structured Prompt, place this sentence immediately after the goal sentence under `【Generation Goal】`, without starting a new paragraph. This is a routing-disambiguation declaration, not a negative constraint on visual content. Do not add it to genuine video editing, video extension, first-frame or first-and-last-frame generation, or regular generation tasks without a specification conflict. If the user already wrote the same or an equivalent declaration, keep it only once and do not repeat it.

For example, `Convert Video1 into a 9:16 vertical frame, keeping the original content completely unchanged and adjusting only the frame composition` should be classified as regular video generation. Video1 serves only as a reference, while 9:16 is set as a generation parameter.

Placement example:

```text
【Generation Goal】
Generate a video using @Video1 as the complete content reference, keeping the original content unchanged and only adapting the composition. Please note that this is not video editing.

【Reference Asset Roles】
@Video1 is used as a reference for visible subjects, scenes, actions, event timing, camera, and sound.

【Event Script】
Preserve the complete event sequence, motion paths, shot changes, and start and end states from @Video1. Do not add, remove, or rewrite any original event.

【Maintain Consistency】
Keep the visible subjects and their count, scene, props, spatial relationships, action order, relationship between camera and sound, and outcome state consistent with @Video1. Adjust only the composition.
```

Set the target aspect ratio through the page or API parameters; do not write it into the final Prompt.

Choose exactly one of the three primary tasks. First determine whether the user wants to modify an existing video, then whether the user wants to add new content before or after an existing video; only otherwise choose generation:

1. **Video Editing**: Use one original video as the unique master and modify only the specified object, region, or sound.
2. **Video Extension**: Generate a new continuous segment before or after the original video without rewriting the original segment.
3. **Video Generation**: Generate a new video from text and optional reference assets.

Multi-asset inputs, long-form video, time ranges, keyframes, storyboard grids, blockouts, sound, emotion, and cinematography are composable modules, not additional primary tasks. When a blockout video is re-rendered as a reference for action, space, or complete structure, the task is video generation; the mere presence of a video input does not automatically route it to video editing.

When the user asks both to edit the original video and extend it, do not discard either operation and do not force them into one Prompt:

- If the replacement content must continue from the original video into the new segment, edit the original video first to produce a new master, then extend the newly edited master.
- If a new subject appears only in the extension and the original video is not modified, perform only the extension and describe the new asset as a reference for the extended segment.
- If multiple operation orders remain equally valid, ask one consolidated question.

When two sequential operations are clearly required, output a two-step execution Prompt. These are consecutive steps in one task, not alternative versions.

### 7. Apply Task Parameter Rules

Use these rules only for planning and guidance; do not write them into the final Prompt:

- **Regular Video Generation**: Set aspect ratio and total duration on the page or through the API. They may guide composition and event density.
- **Video Editing**: Video editing automatically locks the input video's aspect ratio and approximate duration, so neither can be set separately. Because of input-frame processing, the output duration may differ from the original video by up to approximately 0.3 seconds.
- **First-Frame or First-and-Last-Frame Generation**: The first image's aspect ratio locks the output ratio, while duration remains configurable. The first and last images should have the same aspect ratio. When the current Agent can read the images, verify this proactively; when it cannot, do not pretend that it has.
- **Video Extension**: Video extension automatically locks the input video's aspect ratio, while the extension duration remains configurable.

When the user requests a parameter that the selected task locks automatically, do not ask about it, write it into the Prompt, or use it for incorrect planning. Still output the best Prompt first, then append at most one `Parameter Note:` after the main body. When the first and last images have different aspect ratios, likewise use one parameter note explaining that they should be adjusted to the same ratio before submission to avoid stretching the last frame. Output no parameter note when there is no conflict.

### 8. Apply the Template and Clean the Prompt

Choose the corresponding template below and retain only the sections needed for the current task. Replace every `<placeholder>` with concrete content. Do not leave template instructions in the final Prompt.

After completing the Prompt, perform the “Final Self-Check,” then deliver it according to the “Output Contract.”

## Video Generation Templates

### Basic Generation

Suitable for text-only generation or tasks with few references and a simple event:

```text
<Subject> <performs the main action or event> in <scene and environment>.
The visuals present <visual style or mood>.
The camera uses <shot size, camera position, camera movement, or cuts>.
The sound includes <dialogue, ambient sound, sound effects, or music>.
```

Delete any unnecessary visual, camera, or sound line, but the subject and main action or event must be explicit.

Completed example:

```text
A young ceramicist shapes clay on a pottery wheel in a studio at dawn, holding the spinning clay steady with both hands until it forms a narrow-necked vase.
Soft morning light enters through the window on the left, keeping the wooden table and clay in natural warm tones.
The camera begins in a medium shot observing the hand movements, then slowly pushes in toward the mouth of the vase.
The sound preserves the low hum of the wheel, palms rubbing against wet clay, and distant birdsong outside the window.
```

### Generation with Reference Assets

```text
【Generation Goal】
Generate <video type or core event>. The core subject is <subject>, and the principal event is <summary>.

【Reference Asset Roles】
@Image1 is used for <subject>'s <appearance, clothing, structure, or material>.
@Video1 is used for <action, camera movement, or pacing>; do not use <identity, clothing, or scene that could be unintentionally carried over>.
@Audio1 is used for <character or sound type>'s <voice quality, dialogue, ambient sound, or music>.

【Unused Assets】
@Image2, @Video2, and @Audio2 are not used in this task or for people, scenes, props, actions, camera, or sound.

【Subjects and Relationships】
<Subject A> maps to @Image1 and always retains <fixed features>.
The spatial, prop, or identity relationship between <Subject A> and <Subject B> is <relationship>.

【Event Script】
At the start: <state of people, props, and scene>.
Principal event: <continuous action or event>.
At the end: <character positions, prop ownership, or final visual state>.

【Maintain Consistency】
Keep <character identities and count, clothing, prop ownership, spatial directions, and sound relationships> stable.
```

Do not invent a visual style, camera movement, or sound merely to fill the template when the user did not request it. Simple tasks may merge adjacent sections, but must not omit the roles of assets that are actually used.

Completed example:

```text
【Generation Goal】
Generate a video of an old wooden chair being repaired. A carpenter first inspects the loose backrest, then applies wood glue and secures the joint. At the end, the chair is stable again.

【Reference Asset Roles】
@Image1 is used for the carpenter's facial features, short hair, and dark blue work apron; do not use the image background.
@Image2 is used for the old chair's curved backrest, dark wood grain, and worn areas; do not use the person in the image.
@Video1 is used for the hand movements when applying glue and pressing the joint together; do not use the character identity, clothing, or workbench from the video.

【Subjects and Relationships】
The carpenter always wears the dark blue apron defined by @Image1. There is only one old wooden chair, defined by @Image2, throughout the video. The tools remain on the right side of the wooden table.

【Event Script】
At the start, the chair is centered on the wooden table and the backrest joint is loose. The carpenter inspects the joint, applies wood glue, and uses both hands to press the backrest into place and secure it. At the end, the carpenter releases the chair, the backrest remains stable, and the chair's count and appearance remain unchanged.

【Maintain Consistency】
Keep the carpenter's identity and clothing, the chair's structure and count, the tool positions, and the studio's spatial orientation stable.
```

## Organizing Multiple Reference Assets

Organize multiple reference assets in the following order:

```text
role of each asset → subject mapping → grouping by type → subject definitions → scene-by-scene activation
```

Having many reference assets does not mean that all of them should be included in the Prompt. Use only the assets relevant to the current story and scene. Put assets that are available but have not been assigned a role in `【Unused Assets】` within the Prompt, list every unused reference number, and prohibit their activation. Unused assets may be consolidated into one compact line for images, one for videos, and one for audio, but no reference number may be omitted or expressed as a subject-range mapping.

Seedance 2.5 accepts up to 50 reference assets. Even when approaching this limit, classify every asset individually by character, prop, scene, action, or sound, and activate it scene by scene. Do not use a catch-all sentence that leaves allocation to the model, and do not make all assets appear simultaneously merely to demonstrate their quantity.

### Grouping by Type

```text
【Characters】
<Character A> corresponds to @Image1; use only the appearance, hairstyle, and clothing.
<Character B> corresponds to @Image2; use only the appearance, hairstyle, and clothing.
Do not swap the two characters' appearances, clothing, actions, positions, or dialogue.

【Props】
<Prop A> corresponds to @Image3 and belongs only to <Character A>.
<Prop B> corresponds to @Image4 and belongs only to <Character B>.

【Scenes】
<Scene A> references @Image5; use only the space, materials, and lighting.
<Scene B> references @Image6; use only the space, materials, and lighting.

【Actions and Sound】
@Video1 is used for <Character A>'s <action or camera movement>; do not use the characters or scene from the video.
@Audio1 is used for <Character B>'s <voice timbre and specified dialogue>.
```

### Subject Definitions and Scene-by-Scene Activation

```text
【Subject Definition: Character A】
Appearance and clothing: @Image1.
Fixed prop: <Prop A> from @Image3.
Allowed scenes: <Scene A> and <Scene B>.
Action reference: <action> from @Video1.
Do not use: <another subject's clothing, props, or voice>.

Scene 1 | <Scene Name>
Use: <the subjects, props, scene, actions, and sounds activated for this scene>.
Event: <one main event>.
At the end: <observable state>.

Scene 2 | <Scene Name>
Use: <the subjects, props, scene, actions, and sounds activated for this scene>.
Event: <one main event>.
At the end: <observable state>.
```

Multi-angle references for the same subject should assign a role to each image. For example, front, left-side, right-side, and back views jointly define the same entity, and the number of entities in the final video must be stated explicitly.

### Spatial Relationships and Positions

Describe inside/outside, front/back, orientation, distance, and separation relative to stable objects such as doors, tables, vehicles, counters, and roads. Do not rely only on screen-left or screen-right. For example:

```text
The <Clerk> always stands on the inside of the glass display counter, facing outward. <Customer A> and <Customer B> stand side by side on the outside of the counter and speak with the <Clerk> across it.
```

When the user provides a clean blocking diagram, use it for composition, character positions, orientation, and spatial relationships. Do not treat arrows, annotation boxes, or explanatory text in the image as content for the final video.

Completed example with multiple assets:

```text
【Characters】
The Inspector corresponds to @Image1; use only the facial features, short hair, and orange windbreaker.
The Archivist corresponds to @Image2; use only the facial features, glasses, and gray knit cardigan.
Do not swap the two characters' appearances, clothing, actions, or dialogue.

【Props】
The portable recorder corresponds to @Image3, belongs only to the Inspector, and remains the only one throughout.

【Scenes】
The mountaintop observation station references @Image4; use only the building structure, metal platform, and overcast lighting.
The records room references @Image5; use only the bookshelf layout, wooden table, and warm indoor lighting.

【Actions and Sound】
@Video1 is used for the Inspector's action of opening the equipment bay and removing the memory card; do not use the characters or scene from the video.
@Audio1 is used for the Inspector's voice timbre and dialogue.

【Event Script】
Stage 1: The Inspector stands alone in front of the equipment bay at the mountaintop observation station, with the portable recorder hanging at his waist. He opens the equipment bay and removes the single memory card. At the end, the memory card is only in the Inspector's right hand.
Stage 2: Inside the observation station, the Inspector inserts the memory card into the portable recorder. At the end, the recorder's screen shows that data reading is complete, and the memory card remains inside the device.
Stage 3: The shot cuts to the records room. The Archivist stands on the inner side of the wooden table, and the Inspector stands on the outer side. The Inspector places the recorder at the center of the table and says naturally in Mandarin: {This week's observation data has been exported.}
Stage 4: The Archivist picks up the recorder to inspect the data, while the Inspector naturally closes his mouth and waits. At the end, the recorder is only in the Archivist's hands.
Stage 5: The Archivist places the recorder back on the table, and both characters look at the completed status on its screen. End on a medium shot that clearly shows their identities, the number of props, and their positions.

【Maintain Consistency】
Keep both characters' identities and clothing, the recorder's quantity and ownership, the spatial orientation of both scenes, and the speaker relationship consistent.
```

## Long Videos and Time Segments

Seedance 2.5 supports videos up to 30 seconds long. The total duration is set through generation parameters; the Prompt is responsible only for organizing events within that duration.

Event time segments explicitly provided by the user are part of the creative content and must be preserved. Parameter separation removes only interface settings such as "generate an N-second video" or "output in a 16:9 aspect ratio." If the user's original numerical time segments conflict with the target total duration on the page or in the API, prioritize preserving event order, relative pacing, and the story outcome, and switch to unnumbered "stages." Preserve the numbers and ask the user to resolve the parameter conflict only when the user explicitly states that the original time segments are hard constraints.

For long videos, prefer "stages." Assign only one major state change to each stage and clearly state its end state:

```text
【Stage 1】
At the start: <initial state>.
Main event: <one main action or event>.
At the end: <observable state>.

【Stage 2】
Continuing from the previous stage: <state that must be maintained>.
Main event: <one main action or event>.
At the end: <observable state>.

【Stage 3】
Main event: <concluding event>.
At the end: <final visual state>.
```

The number of stages is determined by the number of events and may be increased or decreased; it is not fixed at three. When the Prompt is long, prioritize subject mappings, asset roles, events, and end states. Compress repeated style terms, repeated constraints, and inactive assets. Do not impose a fixed word limit.

### Target-Duration Override

When the target duration provided by the generation page or API context is longer than the user's original event timeline, first preserve the characters, event order, causal relationships, and story outcome, and then redistribute the pacing of the existing events. When the target duration is provided only by the page or API, organize the Prompt into stages without numerical timestamps so that the stages collectively cover the narrative capacity of the target duration. Do not create numerical time segments such as `0-8 seconds` or `8-18 seconds` in the Prompt merely to align with that parameter.

You may lengthen only action processes, reactions, pauses, or scene transitions. For example, allow shifts in gaze, changes in breathing, the process of picking something up, and reactions after entering to unfold naturally. Do not add characters, main-plot events, or story outcomes, and do not mechanically fill time with repeated actions or empty shots. The target total duration still must not be written into the Prompt as an interface parameter sentence.

For handoffs, grabs, and placement tasks, state the ownership change of the single object. For example, after handing it over, the original holder no longer has it; at the end, it is only in the recipient's hands.

Use continuous whole-number time segments only when the user has already provided numerical time segments or explicitly requests time-segment control over handoffs, entrances and exits, or beats. When there are fewer events, do not split them merely to reach a segment count. When there are more events, merge secondary events first:

```text
0-5 seconds: <starting state>; <main event>; at the end, <observable state>.
5-10 seconds: Continue from <state> in the previous segment; <main event>; at the end, <observable state>.
10-15 seconds: <concluding event>; at the end, <final state>.
```

When the user requests numerical time segments, the segments must be continuous and non-overlapping. They represent event budgets, not frame-level edit points. Do not claim precision to 0.5 seconds, and do not give an unverified maximum number of time segments. When events are too dense, reduce the number of stages instead of subdividing them further.

The overall output duration is still set through generation parameters. Do not separately write "generate an N-second video."

## Video Editing Template

An editing task must define one source video as the sole editing master. It cannot merely describe the target visuals and thereby turn into a regeneration task.

For visual edits, first inventory every category of visible subject in the source video, including user-named and unnamed characters, real people, models, animals, props, foreground objects, and background subjects. Explicitly specify whether each category is to be replaced, removed, or kept unchanged. Do not overlook real people, models, props, or background subjects that the user did not name. Objects the user has not requested to modify remain unchanged by default. Include an entire group in the removal or replacement scope only when the user explicitly requests replacing the whole group or asks that the target video retain only specified objects.

If the current Agent cannot view the entire source video or has access only to sparse previews, it must not claim to have exhaustively inventoried every object. After explicitly stating all user-specified replacements, removals, and preserved objects, add this fallback sentence: `Except for the objects explicitly modified above, all other visible characters, props, and background elements in @Video1 remain unchanged and are not to be replaced or removed.` If the user explicitly requests that the target video retain only specified objects, replace this fallback with an instruction to remove all remaining objects as requested.

Every video-editing Prompt must include one of the following two scope-closure statements. The scope closure must not be omitted:

- Local modification: `Except for the objects explicitly modified above, all other visible characters, props, and background elements in @Video1 remain unchanged and are not to be replaced or removed.`
- The user explicitly requests retaining only the target objects: `Except for the objects explicitly retained above, remove all other visible subjects from @Video1; do not add any unspecified objects.`

The source-video subject inventory determines only which objects are replaced, removed, or preserved; it must not be used to change the target asset set already specified by the user. If the user has explicitly assigned @Image3 to an edit object, do not add an unnamed image as an appearance, clothing, group, or auxiliary reference for that object, even if the other image is clearer or contains similar content. Continue to list those assets in `【Unused Assets】`.

```text
【Editing Goal】
Edit @Video1, changing only <original object or region> to <target content>.

【Role of the Source Video】
@Video1 is the sole editing master and governs the original scene, camera position, camera movement, action trajectories, occlusion relationships, and event order.

【Role of the Target Material】
@Image1 is used for the <appearance, structure, or material> of <the target subject, background, or product>; do not use <irrelevant background, characters, or composition>.

【Edit Objects and Scope】
Modify only <explicit objects and regions>. The number of target objects throughout the video is <count>. Do not modify <content that must be preserved>.
Except for the objects explicitly modified above, all other visible characters, props, and background elements in @Video1 remain unchanged and are not to be replaced or removed.

【Timeline Inheritance】
<Target object> inherits the timing, duration, path, and speed changes of every appearance, movement, occlusion, and exit of <original object>.
All other character actions, camera movement, shot changes, and event order remain as in @Video1.
```

When replacing a subject, specify the original and target subjects. When replacing a background, make clear that only the background outside the subject's outline changes. For a local edit, specify the region, attribute, and content to preserve. When adding or removing an object, state its quantity, position, appearance timing, and affected scope.

Completed example of dynamic-subject replacement:

```text
【Editing Goal】
Edit @Video1, replacing only the red bicycle and its rider passing in front of the bench with the dark-gray electric patrol vehicle from @Image1.

【Role of the Source Video】
@Video1 is the sole editing master and governs the park road, the two people on the bench, the camera position, camera movement, the original rider's motion slot, occlusion relationships, and event order.

【Role of the Target Material】
@Image1 is used only for the body structure, color, and transparent windshield of the dark-gray electric patrol vehicle; do not use the image background or driver.

【Edit Objects and Scope】
Remove the red bicycle and its rider from the source video. There must be exactly one electric patrol vehicle throughout the video. The two people on the bench, the trees, the road, and the background remain as in @Video1.

【Timeline Inheritance】
The electric patrol vehicle fills the original rider's motion slot with exactly the same appearance timing, movement path, speed, and occlusion positions. The red bicycle and rider must no longer appear in the final video. All other character actions, camera movement, shot changes, and event order remain as in @Video1.
```

For cross-category dynamic-subject replacement, prefer "motion-slot replacement": explicitly remove the original subject, have the target subject inherit the original subject's exact appearance timing, movement path, speed, and occlusion positions, and state that the original subject no longer appears in the final video. The preservation list should include only areas adjacent to the target that genuinely cannot change. Avoid diluting the editing goal with an overly long list.

```text
Remove <original moving subject> that passes in front of <foreground subject> in @Video1, and replace it with <target moving subject> defined by @Image1 at exactly the same appearance timing, movement path, speed, and occlusion positions. <Original moving subject> must no longer appear in the final video.
```

Use the global master-inheritance requirement by default. Add a small number of observable event conditions only when grabs, handoffs, placements, or entrances and exits in the source video can be observed accurately:

```text
Only after <observable completion state of Event A> occurs may <Event B> begin.
Only after <observable completion state of Event B> occurs may <Event C> begin.
```

Do not rewrite the source video into time segments from memory, and do not invent event conditions from incomplete frame samples. A Prompt can increase the probability that key events follow the original timeline, but it cannot guarantee frame-by-frame alignment after editing.

### Audio Editing

When modifying only dialogue, language, voice timbre, background music, ambience, or action sound effects, still define the source video as the sole editing master. Specify separately the speaker or sound category to modify, the target change, the time range, and whether all other audio and all visuals remain unchanged. Do not redesign character actions, lip-sync timing, shots, or editing rhythm because of an audio edit.

```text
【Editing Goal】
Edit @Video1, applying <removal, replacement, or adjustment> only to <speaker or sound category> in <the entire video or an explicit time segment>.

【Role of the Source Video】
@Video1 is the sole editing master and governs the original visuals, character actions, lip-sync timing, shots, editing rhythm, all other audio, and event order.

【Role of the Target Audio】
@Audio1 is used for the <voice timbre, dialogue, ambience, sound effects, or music> of <target speaker or sound category>; do not use <irrelevant audio>.

【Audio Edit Scope】
Modify only <explicit speaker, sound category, or time segment>.

【Content to Preserve】
Keep <all other dialogue, lip-sync timing, ambience, action sound effects, visuals, shots, and editing rhythm> from @Video1 unchanged.
```

When the user asks only to remove the original background music, do not fabricate a target audio material. State directly that the background music is to be removed while character dialogue, lip-sync, ambience, action sound effects, and all visuals are preserved. When changing the dialogue language or voice timbre, preserve the dialogue content and speaking times from the source video by default unless the user explicitly requests rewriting them as well.

## Video Extension Template

If the user says only "extend" and the direction cannot be determined from context, the direction is high-impact information and must be included in a single consolidated clarification request.

In an extension Prompt, use the user's confirmed name for the subject at the boundary. When the user writes only "person" or "subject," retain that neutral term. Do not infer a profession, performance type, or narrative identity from the subject's actions, posture, or clothing in the source video.

Throughout the extension, the same subject must remain one continuous instance; it must not be duplicated, split, or replaced with a second identical subject. Keep the body structure, number of parts, and topological relationships consistent with the boundary frame. When the subject turns around, becomes occluded, exits the frame, or re-enters, it is still the same continuous object and must not be replaced by a new instance.

The final Prompt must state the single-instance and topology requirements above explicitly; they must not be checked only during internal analysis and then omitted.

### Forward Extension (After the Original Video)

A forward extension continues generation after the source video ends. The first frame of the new segment continues from the source video's final frame.

```text
@Video1 is the source video to extend forward.

Extend @Video1 forward. The first frame of the extended segment directly continues from the final frame of @Video1: maintain continuity in <subject posture and orientation>, <prop positions>, <background and spatial relationships>, <camera position and composition>, <lighting>, <audio state>, and <motion trajectory>.

Then, <new action, event, shot, or sound to add in the extension>.

Throughout the extension, maintain continuity in <character identity and clothing>, <key props>, <background layout>, <camera axis>, and <the original audio environment>.
The same subject must remain the same continuous object throughout, without duplication or splitting; the character's appearance or the number of an object's parts must remain stable.
```

Completed example with additional assets:

```text
@Video1 is the source video to extend forward.
@Image1 is used for the Gardener's facial features, short hair, and light-green work apron; do not use the image background.
@Image2 is used for the structure and material of the woven flower basket; do not use the garden or people from the image.

Extend @Video1 forward. The first frame of the extended segment directly continues from the final frame of @Video1: maintain continuity in the greenhouse workbench, the Gardener's position and orientation, the wooden rack's position, the fixed medium-shot camera position, and the afternoon side lighting. The other reference assets must not replace this boundary frame.

Then, the Gardener picks up the woven flower basket defined by @Image2 from beneath the workbench and places it with both hands on the middle shelf of the wooden rack behind him. At the end, the basket is only on the middle shelf, and the Gardener has released both hands and stepped back half a step.

Throughout the extension, maintain continuity in the Gardener's face and apron, the greenhouse layout, the wooden rack's position, the camera direction, and the greenhouse ambience.
The Gardener and the basket must each remain the same continuous object throughout, without duplication or splitting; the Gardener's body structure and the basket's number of parts must remain stable.
```

### Backward Extension (Before the Original Video)

A backward extension generates content before the source video begins. The final frame of the new segment connects to the source video's first frame.

First describe what happens before the source video begins, and then define the source video's first frame as the explicit end state of the extended segment. Writing only "then connect to the source video" may cause the model to introduce characters, props, or effects from later in the video too early, or to change the image again after reaching the target state.

```text
@Video1 is the source video to extend backward.

Extend @Video1 backward. Before the source video begins, <preceding action, event, shot, or sound>.

The final frame of the extended segment connects naturally to the first frame of @Video1: keep <subject posture and orientation>, <prop positions>, <background and spatial relationships>, <camera position and composition>, <lighting>, <audio state>, and <motion trajectory> consistent.

Throughout the extension, maintain continuity in <character identity and clothing>, <key props>, <background layout>, <camera axis>, and <the original audio environment>.
The same subject must remain the same continuous object throughout, without duplication or splitting; the character's appearance or the number of an object's parts must remain stable.
Characters, props, or effects that belong only to later parts of the source video must not appear early.
```

When additional reference assets are provided, first state each asset's role for characters, clothing, props, or sound, and then state that the source video controls the extension boundary. New assets must not override the source video's control of the boundary image at its final or first frame.

An extension creates only a new segment beyond the boundary; do not edit the source video at the same time. The boundary goal is natural continuity in visuals and sound, not guaranteed pixel-level identity. The volume of the extended segment may differ slightly from that of the source video.

## Keyframe Anchors

Keyframe images are still provided as ordinary reference images; assign each image a specific role in the Prompt. Do not combine the first-frame and last-frame roles into a single range statement.

When fixing the first frame, write `Use @ImageN as the first frame.` as a standalone sentence. When fixing the last frame, write `Use @ImageN as the last frame.` as a standalone sentence. Do not weaken these statements to "use only as a first-frame reference," "reference the opening composition," or "first-frame composition reference." Do not compress the role statement and the subsequent action into the same sentence. The exact role statement must remain verbatim in the final Prompt. Add a separate sentence describing the composition, subject positions, poses, prop states, scene, and camera direction defined by that frame.

The first frame locks the output aspect ratio. The first and last frames should use the same aspect ratio to avoid stretching the last frame; duration is still set on the generation page or through the API. This rule is only for input preflight and must not be written into the Prompt as an output parameter.

### First Frame Plus Other References

```text
Use @Image1 as the first frame.
This first frame defines the composition at the start of the video, subject positions, poses, prop states, scene, and camera direction.
Use @Image2 for the <appearance, clothing, structure, or material> of <the subject> without changing the first-frame composition defined by @Image1.
Use @Image3 for <the scene, props, or lighting> without changing the first-frame composition defined by @Image1.

The shot begins naturally from the first frame defined by @Image1, followed by <a continuous action or event>.
Maintain continuity in <character identities, prop ownership, spatial relationships, and visual style>.
```

### First Frame, Last Frame, and Other References

```text
Use @Image1 as the first frame.
This first frame defines the composition at the start of the video, subject positions, poses, prop states, scene, and camera direction.
Use @Image2 as the last frame.
This last frame defines the composition at the end of the video, subject positions, poses, prop states, scene, and camera direction.
Use @Image3 for <Subject A>'s <appearance, clothing, structure, or material> without changing the first-frame composition in @Image1 or the last-frame composition in @Image2.
Use @Image4 for <the specified attributes> of <Subject B, a prop, or the scene> without changing the first-frame composition in @Image1 or the last-frame composition in @Image2.

<One continuous action or event>.
The shot begins naturally from the first frame defined by @Image1 and, after a continuous action, arrives at the last frame defined by @Image2.
Maintain continuity from first to last in <character identities, prop structure and ownership, scene layout, and camera direction>.
```

Completed example:

```text
Use @Image1 as the first frame.
This first frame defines the baking station, the cake decorator's position, the undecorated cake, tool placement, and a frontal medium-shot camera position.
Use @Image2 as the last frame.
This last frame defines the decorated cake centered on the turntable, the cake decorator's hands away from the cake, and the same frontal medium-shot camera position.
Use @Image3 for the cake decorator's facial features, updo, and white uniform without changing the first-frame composition in @Image1 or the last-frame composition in @Image2.
Use @Image4 for the cake's two-tier structure, white frosting texture, and blueberry decorations without changing the first-frame composition in @Image1 or the last-frame composition in @Image2.

The shot begins naturally from the first frame defined by @Image1. The cake decorator rotates the cake turntable, continuously pipes even cream patterns along the edges of both tiers, and then places the blueberries one by one. Finally, the decorator moves both hands away from the cake and naturally arrives at the last frame defined by @Image2.
Maintain continuity from first to last in the cake decorator's identity and clothing, the number and two-tier structure of the cake, tool positions, the baking-station layout, and camera direction.
```

When the user explicitly requests an intermediate key state, an additional image may define the characters, actions, props, and spatial relationships that must appear at that moment; describe the shot as naturally reaching that state around the specified time. It is a semantic anchor, not a static hold or a pixel-locked frame. When the first-frame and last-frame boundaries take priority, reduce other assets unrelated to the current event.

### Controlling the Order of Multiple Keyframes

When multiple independent images define separate process stages, use the first sentence to declare the keyframe order, then describe each key state image by image. Keyframes control stage order and visible states; they do not promise frame-by-frame replication or require a static hold at any key state.

```text
Use @Image1 through @ImageN as keyframes in that order.

Use @Image1 as the first frame.
This first frame defines <the starting composition, subject positions, poses, prop states, and camera direction>.
@Image2 defines the second keyframe: <the visible state at the end of the first stage>.
@Image3 defines the third keyframe: <the visible state at the end of the second stage>.
Use @ImageN as the last frame.
This last frame defines <the ending composition, subject positions, poses, prop states, and camera direction>.

The shot passes through the states defined by @Image1, @Image2, @Image3, and onward to @ImageN in order, using continuous action to transition naturally between stages.
Throughout the process, maintain continuity in <subject identities, prop structure and ownership, scene layout, lighting, and the camera axis>.
```

### Storyboard Grids and Storyboards

A storyboard grid defines the overall story, shot order, and approximate composition; it does not require strict replication of every panel's details. Prefer clean storyboards with no more than 15 panels and minimal text annotations. Specify the reading order, the shot structure to adopt, and any sketch style, annotations, or placeholder characters not to adopt.

```text
@Image1 provides the shot order and approximate compositions for an <N-panel storyboard grid>. Read it <from left to right and from top to bottom>; do not adopt <the sketch style, text annotations, or placeholder characters> shown in the image.
@Image2 defines <Subject A>'s <appearance and clothing>.
@Image3 defines <the structure, material, or lighting> of <a key prop or scene>.

Shot 1: <shot size, subject action, and scene state>.
Shot 2: <shot size, subject action, and camera movement or transition>.
...
Shot N: <ending action and final visual state>.

The final visuals use <visual style>. The audio includes <dialogue, ambience, action sound effects, or music>.
```

### Blockout References and Rendering

First determine whether the blockout video provides a motion skeleton or a complete structure:

- **Coarse blockout**: Simple geometry mainly provides action paths, direction of movement, subject blocking, entrances and exits, camera position, camera movement, cuts, lighting changes, audio rhythm, or spatial relationships. Map every geometric object individually to a final subject or prop.
- **Fine blockout**: The structure of the subjects, props, or scene is already complete. It is mainly used to replace character appearance, materials, colors, the scene, or the visual style. Preserve the existing structure, actions, spatial relationships, and camera work.

A blockout video is a generation reference; it does not automatically become the editing master merely because it is a video. If the blockout contains trajectory lines, coordinate axes, controllers, camera frustums, or text markers, explicitly exclude those production markers.

#### Coarse Blockout

```text
@Video1 is a coarse-blockout reference. Use it only for <action paths, subject blocking, camera position, camera movement, cuts, lighting changes, audio rhythm, or spatial relationships>; do not adopt its blockout appearance, materials, or scene.
<Blockout Subject A> in @Video1 corresponds to <Subject A>.
<Blockout Subject B or geometric prop> in @Video1 corresponds to <Subject B or a key prop>.
@Image1 defines <Subject A>'s <appearance, clothing, or structure>.
@Image2 defines <the specified attributes> of <Subject B, a key prop, or the scene>.

<The subject> completes <the primary action or event> in <the scene>.
Preserve <the action paths, blocking, camera movement, cuts, lighting, or audio rhythm> from @Video1.
The final visuals use <the characters, scene, materials, and visual style>. The audio includes <dialogue, ambience, or action sound effects>.
```

#### Fine Blockout

```text
@Video1 is a fine-blockout reference. Preserve <subject structure, actions, spatial layout, camera position, camera movement, and cuts>; do not adopt its original gray-blockout materials, blank background, or production markers.
@Image1 defines <the character appearance, material, color, or surface details> of <the subject>.
@Image2 defines <the space, materials, lighting, or visual style> of <the scene>.

Rerender <the subject> in @Video1 as <the final subject>, and rerender the scene as <the final scene>.
Preserve <the structure, actions, camera work, and spatial relationships> from @Video1. The visuals present <materials, colors, and style>. The audio includes <ambience, sound effects, or music>.
```

## Emotion, Cinematography, and Sound

### Emotion and Observable Performance

When only a direction such as tense, warm, or oppressive is given, allow the model to determine the specific performance. When the user needs control over the acting, use:

```text
emotional or atmospheric direction + triggering event + the character's observable performance + observable changes in camera work, lighting, or sound
```

Choose a small number of the clearest cues from the eyes, brows, mouth, breathing, gaze, hand movements, and body posture. Do not pile on every possible microexpression. Divide the performance into stages by triggering event only when the emotion changes multiple times.

```text
The overall emotion shifts from <starting emotion> to <ending emotion>.
After <triggering event>, <the subject> first shows <an immediate observable reaction>.
Then, <the eyes, brows, mouth, breathing, gaze, or hand movements> gradually <change>.
Finally, <the subject> expresses <the target emotion> through <an outwardly observable performance>.
```

Completed example:

```text
The overall emotion shifts from restrained anticipation to trying to stay composed after disappointment.
After seeing the waiter place a returned letter on the table, the woman's fingers tracing the rim of her cup suddenly stop, and her gaze falls on the return mark on the envelope.
Her brows tighten slightly, her faint smile gradually disappears, and after a slow breath in, she turns the envelope face down on the table.
Finally, she looks up at the empty chair across from her, keeps her shoulders straight, and says in a calm but slightly strained voice: {I understand.}
```

### Professional Cinematography

Basic shot language and popular camera movements can be written directly into the Prompt. When the frame contains multiple subjects, still specify which subject the camera centers on, where the move begins, and where it ends. Do not use only a term detached from its subject.

```text
popular camera movement + target subject + starting position or state + direction of movement + arrival position or state
```

Popular camera movements include a continuous one-take shot, dolly zoom, aerial perspective, FPV, bullet time, handheld camera work, and rebound speed ramping. For a continuous one-take shot, specify the sequence of subjects, spaces, and events the camera passes through. For handheld camera work, specify the tracked subject and the degree of shake. For rebound speed ramping, specify the action beat at which the movement accelerates, decelerates, or rebounds, as well as the final hold state.

For highly specialized cinematography terms, terms whose industry meanings are inconsistent, or terms that require precise control over visual changes, retain the term and expand it into observable results:

```text
cinematography term + target subject + visual change + foreground/background relationship + direction or speed
```

For example, shallow depth of field should specify that the subject remains sharp and how the background blurs. A tracking shot should specify that the camera matches the subject's speed and the direction of the background motion blur. A rack focus should specify which object the focus moves from and which object it moves to, and how each object's sharpness changes. A vignette should specify that the four corners gradually darken while the center retains normal brightness. Focal-length, aperture, and shutter values may only supplement these instructions; they cannot replace the final visible result.

### Sound, Dialogue, and Text

Use the following when content types need to be distinguished:

| Content      | Symbols | Example                                      |
| ------------ | ------- | -------------------------------------------- |
| Music        | `()`    | `(Soft piano music plays in the background)` |
| Sound effect | `<>`    | `<A bell rings in the distance>`             |
| Dialogue     | `{}`    | `{Hello, welcome back}`                      |
| Subtitle     | `【】`  | `【Chapter 1: Departure】`                   |

For dialogue language, use: `language + optional regional variety or accent + delivery + speaker + {dialogue}`. Label each speaker separately; do not make a single blanket declaration at the beginning. If English dialogue is likely to be spoken in Chinese, explicitly write at least "Use English." When the user explicitly specifies a regional variety or accent, or explicitly asks for stronger reinforcement, use a complete instruction such as "natural, conversational American English" or "authentic Los Angeles English." If the user provides only English dialogue, do not add an American, British, or regional accent without instruction. If the user does not specify the dialogue language, do not infer Mandarin, a dialect, or a regional accent from the writing system. When subtitles are unnecessary, also state that no subtitles appear on screen.

For multi-speaker dialogue, bind the speaker and audio at each stage, and state that the other characters keep their mouths naturally closed while listening. Identify the sources of ambience, sound effects, and music separately so unrelated audio is not mistaken for background music.

If the final Prompt uses `<>` to mark sound effects, do not also enclose subject names in angle brackets. Use ordinary character names so the same symbols do not serve two roles.

For tasks without dialogue, constrain speech, lip movement, sound sources, and visible text carriers at the same time. For example, characters keep their mouths naturally closed, there is no narration, only the specified ambience remains, and no subtitles or signs appear on screen.

### Products and Physical Processes

Convert abstract selling points such as efficient, intelligent, or reliable into "initial state -> specific operation -> observable result." Show only one operation or functional result in each stage, and continuously preserve product appearance, component positions, the operator, and scene relationships.

```text
Stage 1: At the start, <the initial state of the product and its components>; <the operator completes one specific operation>; at the end, <a directly visible state>.
Stage 2: Continue from <the previous stage's state>; <the product performs one function>; at the end, <a directly visible result>.
Stage 3: <The operator completes the concluding operation>; at the end, <the final state of the product, its components, and the finished output>.
```

Completed example:

```text
Stage 1: At the start, the desktop humidifier is off, its water tank is empty, and the top cover is placed to the right of the unit. The operator removes the water tank and fills it with clean water. At the end, the water level is below the maximum fill line.
Stage 2: The operator reinstalls the water tank, closes the top cover, and presses the power button once. At the end, the operator's hand has moved away from the button, and the humidifier remains in a fixed position.
Stage 3: A continuous stream of fine white mist emerges from the outlet and rises vertically, with no water accumulating on the desktop. At the end, the unit, water tank, and top cover remain visually intact.
```

Do not write only "show the complete process of installing, operating, and completing the product workflow." Exact on-screen text, formulas, and product parameters remain subject to the capability boundaries in the Output Contract.

## Output Contract

Match the user's output language. Retain the user's existing asset-reference syntax, such as `@Image1`, `@Image 1`, or an equivalent label in the runtime environment. Do not translate or renumber any reference the user has explicitly established.

### Default Delivery

By default, output only the optimized Prompt body. Do not add Markdown headings, code fences, prefaces, or closing explanations, and do not add outer wrappers such as "Optimized Prompt," "Asset Understanding," or "Optimization Notes." Do not instruct the model to wrap the final result in a code fence.

When the Prompt itself needs structure, it may retain task-internal labels such as `【Generation Goal】`, `【Reference Asset Roles】`, `【Event Script】`, and `【Maintain Consistency】`. These labels are part of the directly submittable Prompt body, not response wrappers.

When the Agent infers asset mappings automatically, do not output a separate reasoning table. Write the final mappings directly into the Prompt's reference-asset-roles section, specifying the adopted scope of every asset actually used. When the Agent can access the complete asset inventory, it must append `【Unused Assets】` inside the Prompt and individually list the reference number of every actually available asset that was not assigned a role; do not describe them only outside the Prompt. When the complete asset inventory is unavailable in the current environment, do not fabricate unused reference numbers.

### Asset Reference Fidelity

When the user's original Prompt already contains explicit asset references, retain the same reference syntax and numbers in the final Prompt, regardless of whether the current Agent can access the corresponding assets. Do not delete or renumber a reference, translate its label, or convert the task into reference-free generation merely because the asset is not attached to the current message, is corrupted, or cannot be accessed.

Inaccessible assets limit only the facts the Agent can confirm and add. They do not alter the asset roles or reference relationships the user has already established, and they do not trigger any missing-asset explanation or supplementary advice outside the Prompt.

### Input and Parameter Notices

When the input assets exceed a hard limit, first output a complete Prompt based on the selected assets, then append one `Asset Note:` listing the asset types or reference numbers that must be reduced before submission. Recommended ranges are not hard limits and do not trigger an asset note.

When the user requests parameters that are automatically locked by video editing, first-frame generation, first-and-last-frame generation, or video extension, or when the first and last frames have mismatched aspect ratios, first output the complete Prompt, then append one `Parameter Note:`. The parameter note states only the conflicting rule and the action required before submission. It does not repeat the Prompt, expand into API documentation, or write the parameters back into the Prompt.

Example: `Parameter Note: Video editing automatically preserves the input video's aspect ratio and basic duration, so these cannot be set separately to 16:9 and 20 seconds. The Prompt above has been written to follow the original video's timeline.`

### Required Capability Boundaries

Exact subtitles, formulas, signs, product parameters, or frame-level timestamps cannot be fully guaranteed by the Prompt alone. Still output the best possible Prompt first. When genuinely necessary, append at most one line beginning with `Additional Note:` after the Prompt, stating that prepared assets or post-production are required. When unnecessary, output no note.

For a hybrid task containing two sequential operations, output separate, submittable Prompts labeled `Step 1:` and `Step 2:`, and state that Step 2 uses the output from Step 1 as its new master. Otherwise, output only one Prompt by default.

In an ordinary generation task, a user-provided duration, aspect ratio, or other generation parameter may guide event density and composition, but must not be written into the Prompt. For video editing, first-frame generation, first-and-last-frame generation, or video extension, apply the task's automatically locked rules first and do not use conflicting parameters to plan the Prompt. List configurable parameters outside the Prompt only when the user asks for an invocation example.

### Complete Input-to-Output Example

User input: `Have the barista from the reference image perform a pour-over in the reference cafe, following the actions in the uploaded video, and finally hand the coffee to the customer.`

After reviewing the three assets, the Agent directly outputs the following Prompt body:

【Generation Goal】
Generate a continuous video of the barista completing a pour-over and handing the coffee to the customer.

【Reference Asset Roles】
Use @Image1 for the barista's facial features, short hair, and brown apron; do not adopt the image's background.
Use @Image2 for the cafe's wooden counter, glass windows, and warm afternoon light; do not adopt the people in the image.
Use @Video1 for the pouring rhythm and wrist movements during the pour-over; do not adopt the identities, clothing, or scene from the video.

【Event Script】
At the start, the barista stands on the inner side of the counter, the customer stands on the outer side, and the dripper and serving carafe are between them. Following the action rhythm in @Video1, the barista slowly pours the water. After finishing the pour, the barista returns the dripper to its holder, then uses both hands to hand the only cup of coffee to the customer. At the end, the coffee is held only by the customer, and both of the barista's hands have moved away from the cup.

【Maintain Consistency】
Maintain the barista's identity and apron, the cafe layout, the positions on the inner and outer sides of the counter, and the number of coffee cups.

## Final Checklist

Before output, confirm each item:

- A single Prompt has exactly one primary task: generation, editing, or extension. An explicit hybrid task has been split into two sequential Prompts, each with exactly one primary task.
- The subjects, counts, identities, scene, prop ownership, spatial relationships, and story outcome have not changed.
- Every required character, prop, and scene in the story contract is covered. Two named characters have not been merged, and inferences from assets have not been written as facts about identity, age, relationships, or plot.
- Every asset actually used has one unique and explicit role.
- Asset references already present in the user's original Prompt remain exactly unchanged. None have been deleted, renumbered, translated, or converted into reference-free generation because the assets were not attached or could not be accessed; no asset reference absent from the user's input has been invented.
- When assets are missing, corrupted, or inaccessible, the Agent has not claimed to have reviewed them and has not added appearance, voice, action, or scene details that could be confirmed only by reviewing those assets.
- Irrelevant assets have not been forced into the output. When the complete asset inventory is available, every actually available asset that was not assigned a role is listed individually under `【Unused Assets】`.
- Inaccessible assets have not been treated as understood.
- Different characters, products, and props are mapped individually, not replaced by a range statement.
- A single-character design image has not been used to define two on-screen characters. When multiple individual or group candidates exist, they have first been assigned as one image per person and one image per group.
- Each stage of a long video has only one primary state change and a clear ending state.
- Event time ranges explicitly requested by the user have not been removed without authorization. When only an external target duration exists, the existing events have been redistributed using stages without numeric timestamps, and the parameter has not been written back as new time ranges.
- An editing task includes a sole master, edit scope, target count, content to preserve, and timeline inheritance. Audio editing also specifies the audio to change, audio to preserve, lip-sync timing, and all visuals.
- The current task's automatically locked aspect-ratio and duration rules have been followed. When a conflict exists, only one parameter note is output outside the Prompt.
- The extension direction and boundary-frame role are correct, and the original video is not rewritten at the same time. The boundary visuals, audio state, movement trend, and continuing subjects are all covered.
- The first frame, last frame, and other reference images are defined individually without overwriting one another's roles. A fixed frame uses the standalone exact role statement `Use @ImageN as the first frame.` or `Use @ImageN as the last frame.` and does not weaken it to a composition reference. The aspect ratios of the first and last frames have been checked or handled under the inaccessible-media boundary.
- Multiple keyframes define key states image by image and in order, without promising frame-by-frame replication or a static hold.
- A storyboard grid specifies the reading order, each panel's shot role, and any sketch, annotation, or placeholder content not to adopt.
- A blockout has been identified as coarse or fine, with subject mapping, inherited information, and excluded content specified accordingly.
- Abstract emotion and cinematography terms have observable results when control is needed.
- At every speaking stage, the speaker, speaking state, dialogue, audio role, language, and on-screen or off-screen position match the input. Speech has not been changed to silence, and Mandarin, a dialect, or a regional accent has not been added without instruction.
- Shot numbers, asset reference numbers, chapter numbers, and step numbers remain identifiers; they have not been misinterpreted as camera angles or other cinematography parameters.
- The Prompt contains no output parameters, internal analysis, evaluation metadata, keys, Endpoints, or reasons for modifications.
- Exactly one `Please note that this is not video editing.` is included only when the compatibility gate is triggered for reference-based generation. It is not added automatically for actual video editing, video extension, first-frame generation, first-and-last-frame generation, or ordinary generation without a specification conflict.
- When reference-video specifications cannot be accessed, the compatibility decision follows the explicit aspect-ratio or duration intent in the original Prompt. Existing video references remain intact, and the Agent does not claim to have read or checked the reference-video specifications.
- No negative constraint unrelated to the user's request has been added automatically.
- All placeholders have been replaced. By default, the output contains one complete Prompt body only, without Markdown headings, code fences, or surrounding explanations.

## Compatibility And Runtime Notes

- **Text-only Agent**: Handles text and explicit reference labels; it must not claim to have viewed attachments or the contents of file paths.
- **Multimodal Agent**: Reads images, videos, and audio within the permissions available at runtime, then performs two-pass asset understanding and automatic mapping.
- **No filesystem access**: Retain the user's existing labels; for inaccessible paths, apply the `Current Agent Cannot Read the Assets` fallback without claiming to have inspected them.
- **No network access**: Do not attempt to inspect the content of remote URLs or infer asset content from URL names.
- **Output only**: This Skill outputs text and does not require file writes, network access, tool calls, or binary-output capabilities.
