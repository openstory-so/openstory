---
title: Music & Audio
description: Generate, customize, and merge music and sound effects for your sequence
section: User Guide
order: 5
---

The **Music** tab lets you generate AI music and sound effects that match your sequence's mood and merge them with your video.

## Music Generation

OpenStory automatically generates a music prompt and tags from your script during analysis. The Music tab shows:

### Prompt Ready State

When the music prompt is ready but not yet generated:

- **Editable prompt** — The AI-generated music prompt describing the desired soundtrack. You can edit this before generating.
- **Tags** — AI-generated genre/mood tags (e.g., "cinematic, ambient, dramatic")
- **Model selector** — Choose which music generation model to use
- **Duration** — Defaults to the total video duration. Shows a warning if the video duration exceeds the model's maximum.
- **Generate Music** button

### Generating State

A spinner with "Generating music..." text. Music generation happens asynchronously.

### Completed State

Once music is generated:

- **Audio player** — HTML5 audio controls for previewing the track
- **Model selector** — Switch models for regeneration
- **Read-only prompt and tags** — Shows what was used to generate
- **Regenerate Music** — Generate a new track with different settings
- **Merge with Video** — Combine the audio track with your video clips into a final video

### Failed State

If generation fails, the error message is displayed with a **Retry** button.

## Music Models

| Model                | Vendor     | Max Duration | Capabilities                         |
| -------------------- | ---------- | ------------ | ------------------------------------ |
| **ElevenLabs Music** | ElevenLabs | 10 minutes   | Prompt-based, instrumental (default) |
| **MiniMax Music v2** | MiniMax    | 5 minutes    | Prompt + lyrics, instrumental        |
| **ACE-Step 1.5**     | ACE Studio | 4 minutes    | Open weight, prompt + lyrics         |
| **Lyria 2**          | Google     | 30 seconds   | Short-form, instrumental             |
| **MMAudio V2**       | MMAudio    | 8 seconds    | Video-to-audio SFX                   |
| **ElevenLabs SFX**   | ElevenLabs | 22 seconds   | Sound effects                        |

### Duration Limits

Each model has a maximum duration. If your video exceeds it, a warning appears:

> Video is 95s but lyria_2 max is 30s — music will be clamped.

## Merging Video and Music

After generating music, click **Merge with Video** to combine:

1. All motion clips are concatenated in scene order
2. The music track is mixed in
3. A final `.mp4` file is produced

The merge status shows as "Merging..." with a spinner. When complete, the merged video appears in the **Theatre** tab.
