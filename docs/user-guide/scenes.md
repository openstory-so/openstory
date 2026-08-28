---
title: Working with Scenes
description: Explore, edit, and regenerate individual scenes in your sequence
section: User Guide
order: 2
---

The **Scenes** tab is the primary workspace for reviewing and refining your generated sequence. It provides a split-panel interface with a scene list, a media player, and detailed editing tabs.

## Layout

The scenes view has three main areas:

- **Scene List** (left sidebar on desktop, bottom drawer on mobile) — Scrollable list of all scene thumbnails with status indicators
- **Scene Player** (center) — Large preview showing the selected scene's image or video, sized to your sequence's aspect ratio
- **Detail Tabs** (below the player) — Six tabs for inspecting and editing each scene

## Scene List

Each scene in the sidebar shows:

- **Thumbnail** — The generated image (or a placeholder if still generating)
- **Status indicators** — Visual badges showing image and motion generation status
- **Scene number** — Sequential position in the sequence

Click any scene to select it. On mobile, scenes appear in a bottom drawer that can be pulled up.

### Batch Motion Generation

At the top of the scene list, a **Generate Motion** button lets you start video generation for all eligible frames at once (frames with completed images but no video). You can optionally include music generation in the batch.

## Scene Player

The central player displays:

- **Still image** — When no video exists yet
- **Video playback** — When motion has been generated, with play/pause controls
- **Progress overlay** — During generation, shows the current phase name
- **Model hint** — When the inspector model differs from the current still, a badge points at Set Image / Generate without replacing the primary image

The player automatically sizes to match your sequence's aspect ratio (16:9, 9:16, or 1:1).

## Detail Tabs

Below the player, six tabs provide different views and controls for the selected scene.

### Variants Tab

Generate multiple visual interpretations of a scene. This is useful for A/B testing different compositions or finding the best framing.

- **Generate Scene Variants** — Creates a grid of variant images using the selected image model
- **Click any variant** to set it as the scene's primary image
- **Choose a different model** before generating to compare outputs across providers

### Script Tab

Shows the original script extract for this scene — the exact text from your screenplay that corresponds to this scene. Also displays the scene duration.

### Cast Tab

Shows which characters appear in this scene. Each character links to their detail page where you can view their full profile and recast them.

### Location Tab

Shows the location for this scene with its reference image and details. Links to the location's detail page for updating references.

### Image Tab

Full control over the scene's image generation:

- **Editable prompt** — The full visual prompt used to generate the image. Edit it to refine the composition, lighting, or details.
- **Character count** — Displayed in real-time as you edit
- **Model selector** — Switch between image models for this specific scene
- **Optimised prompt** — A collapsed panel for the currently selected model only. Expand it to read the assembled prompt (reference bindings included); toggle **JSON** to copy the exact request body.
- **Shorten Prompt** — AI-powered prompt compression that preserves intent while reducing length. Shows the reduction percentage (e.g., "Prompt shortened by 35% (2400 to 1560 chars)")
- **Generate Image** / **Regenerate Image** — Create a new image with the current prompt and model
- **Set Image** — When previewing a variant from a different model, set it as the scene's primary image
- **Copy Prompt** — Copy the prompt to clipboard

### Motion Tab

Control over the scene's video generation:

- **Editable prompt** — The motion direction prompt (camera movements, character actions). Edit to change the animation style.
- **Model selector** — Switch between video models for this scene. Models are filtered by aspect ratio compatibility and style category.
- **Optimised prompt** — A collapsed panel for the currently selected model only. The header shows character count against that model's maximum prompt length (highlighted if over). Expand it to read the assembled prompt (dialogue, audio cues, reference bindings); toggle **JSON** to copy the exact request body.
- **Generate Motion** / **Regenerate Motion** — Create a new video clip
- **Copy Prompt** — Copy the assembled prompt to clipboard

## Smart Retry

If any images or videos fail to generate, a **failure summary banner** appears at the top of the scenes view with:

- A count of failed items
- **Smart Retry** — Automatically retries only the failed items
- **Regenerate All** — Takes you back to the script tab for a full regeneration

## Real-Time Progress

During generation, progress banners show:

- **Generation Progress** — For the initial pipeline (script analysis, image generation, etc.) with phase indicators
- **Motion Progress** — For batch motion generation, tracking individual frame completion
- **Estimated time** — Based on the number of frames and selected model

Progress updates arrive via Server-Sent Events (SSE) in real-time. If the connection drops, the UI falls back to polling.
