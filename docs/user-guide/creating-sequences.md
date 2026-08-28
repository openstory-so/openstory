---
title: Creating Sequences
description: How to create and manage video sequences in OpenStory
section: User Guide
order: 1
---

Sequences are the core unit of work in OpenStory. Each sequence represents a video project that progresses from script to finished video.

## Creating a New Sequence

1. Navigate to **Sequences** from the top navigation
2. Click **Create New Sequence**
3. You'll be taken to the script editor where you can configure your sequence

### Writing Your Script

The script editor accepts anything from a one-line idea to a full screenplay:

- **One-liner or URL** — Type a brief concept like "A cat exploring a cyberpunk city at night" or paste a website URL. Use **Enhance Script** to expand it into a full screenplay.
- **Full screenplay** — Paste a complete screenplay and click **Generate Sequence** directly.

The editor starts empty. Its placeholder reads: _"Paste a screenplay, or a one-liner we can expand."_

### Enhance Script

For short scripts (under ~1000 characters), OpenStory nudges you to enhance before generating. The **Enhance Script** button (bottom-right of the editor, marked with a sparkle icon) uses AI to expand your idea into a detailed screenplay with:

- Visual descriptions
- Camera directions
- Scene breakdowns
- Dialogue and action lines

Before enhancing, you choose a **target video duration**:

| Preset | Duration   |
| ------ | ---------- |
| 15s    | 15 seconds |
| 30s    | 30 seconds |
| 1m     | 1 minute   |
| 2m     | 2 minutes  |
| 3m     | 3 minutes  |

The enhanced script streams in real-time. You can:

- **Stop** enhancement mid-stream (click Stop or press `Esc` / `Cmd+.`)
- **Undo** the enhancement to restore your original script
- Edit the enhanced script before generating

### Keyboard Shortcuts

| Shortcut           | Action                  |
| ------------------ | ----------------------- |
| `Cmd + Enter`      | Generate sequence       |
| `Esc` or `Cmd + .` | Stop script enhancement |

## Generation Settings

Click the settings button in the control bar to configure all generation parameters. Settings are persisted in localStorage so they carry across sessions.

### Aspect Ratio

Choose the output aspect ratio for all generated images and videos:

| Ratio    | Use Case                                                 |
| -------- | -------------------------------------------------------- |
| **16:9** | Landscape — standard widescreen video                    |
| **9:16** | Portrait — vertical/mobile video (TikTok, Reels, Shorts) |
| **1:1**  | Square — social media posts                              |

### Analysis Model

The AI model used to analyze your script and break it into scenes. You can select **multiple models** to generate parallel sequences — one per model — for comparison. Available models include options from Anthropic, Google, OpenAI, xAI, Mistral, DeepSeek, and more.

When multiple models are selected, the footer shows "N sequences will be created" to confirm.

### Image Model

The AI model for generating scene images. You can select **multiple image models** to generate variant images across different providers. Available models include:

| Model                      | Vendor            | Notes                                                |
| -------------------------- | ----------------- | ---------------------------------------------------- |
| Nano Banana 2              | Google            | Fast generation and editing (default)                |
| Nano Banana Pro            | Google            | Enhanced realism and typography                      |
| Grok Imagine Image 2.0     | SpaceXAI          | Newest Imagine image model, 1K/2K, edit up to 3 refs |
| Grok Imagine Image Quality | SpaceXAI          | Quality Mode — higher fidelity, stronger text        |
| FLUX.2 Max                 | Black Forest Labs | Exceptional realism and consistency                  |
| Phota                      | Phota             | Character consistency via profiles                   |
| Hunyuan Image v3           | Tencent           | Open weights with strong composition                 |
| FLUX.2 Dev                 | Black Forest Labs | 32B open weights                                     |
| Qwen Image 2 Pro           | Alibaba           | Apache 2.0, native 2K, text rendering                |
| HiDream I1                 | HiDream           | MIT licensed, 17B parameters                         |
| Seedream 5.0 Pro           | ByteDance         | Flagship generation and editing                      |

### Motion Model

The AI model for image-to-video animation. Toggle **Auto-generate motion** to automatically create video clips for each scene after images are generated.

| Model              | Vendor     | Est. Time                    |
| ------------------ | ---------- | ---------------------------- |
| LTX 2.3 Pro        | Lightricks | ~15s (open weight)           |
| Veo 3.1            | Google     | ~25s                         |
| Kling v3 Pro       | Kling      | ~20s                         |
| Grok Imagine Video | SpaceXAI   | ~20s                         |
| MiniMax Hailuo 02  | MiniMax    | ~15s                         |
| Seedance 2.0       | ByteDance  | ~20s (default; native audio) |

### Music Model

Toggle **Auto-generate music** to automatically create a soundtrack after scene generation. Choose from:

| Model            | Vendor     | Max Duration | Type                    |
| ---------------- | ---------- | ------------ | ----------------------- |
| ElevenLabs Music | ElevenLabs | 600s         | Music (default)         |
| MiniMax Music v2 | MiniMax    | 300s         | Music (supports lyrics) |
| ACE-Step 1.5     | ACE Studio | 240s         | Music (open weight)     |
| Lyria 2          | Google     | 30s          | Music                   |
| MMAudio V2       | MMAudio    | 8s           | SFX (video-to-audio)    |
| ElevenLabs SFX   | ElevenLabs | 22s          | Sound Effects           |

## Pre-Generation Options

Before generating, you can optionally attach resources from your libraries:

### Talent Suggestions

Click the talent icon to attach characters from your **Talent Library**. The AI will use these as visual references when generating character appearances, ensuring consistency with your established character designs.

### Location Suggestions

Click the location icon to attach locations from your **Location Library**. The AI will reference these when generating scenes set in matching environments.

Both are marked as "optional" in the UI — sequences work fine without them.

## Style Selection

Below the script editor, choose a **visual style** that defines the aesthetic of your sequence. Styles appear as a grid of tiles with preview images. Click any tile to select it, or click **More** to browse the full style catalog in a dialog.

Each style includes configuration for color palette, artistic direction, and rendering approach. The selected style influences:

- Image generation prompts
- Color palette and mood
- Camera and lighting defaults

## The Generation Pipeline

When you click **Generate Sequence**, OpenStory runs an automated pipeline:

1. **Script Analysis** — The AI model breaks your script into individual scenes with metadata (title, duration, location, time of day, story beat)
2. **Character Extraction** — Characters are identified from the script with physical descriptions, clothing, and consistency tags
3. **Location Extraction** — Settings are extracted with architectural details, lighting, and ambiance
4. **Image Prompts** — Visual prompts are generated for each scene incorporating style, characters, and locations
5. **Image Generation** — Scene images are generated using your selected image model(s)
6. **Motion Generation** — If auto-motion is enabled, each image is animated into a video clip
7. **Music Generation** — If auto-music is enabled, a soundtrack is generated based on the script's mood

Progress is shown via a real-time banner with phase indicators. You can navigate away and return — the process continues in the background via durable workflows.

## Regenerating a Sequence

From the **Script** tab of an existing sequence, you can edit the script and click **Regenerate Sequence**. This creates a new sequence from the modified script (the original is preserved).
