---
title: Styles
description: Choose visual styles that define the aesthetic of your sequences
section: User Guide
order: 9
---

Styles define the overall visual aesthetic of your sequence — color palette, artistic direction, lighting, and rendering approach. Every sequence requires a style.

## Selecting a Style

When creating or editing a sequence, the style selector appears below the script editor as a row of tiles.

### Quick Selection

The most popular styles are shown directly as square tiles with:

- **Preview image** — A sample image showing the style's look
- **Name overlay** — The style name at the bottom of the tile
- **Selection highlight** — A primary-color border and subtle scale-up when selected

### Full Catalog

Click the **More** tile (shown with a `...` icon) to open the full style selection dialog. This shows all available styles with larger previews, names, and categories. Click any style to select it and close the dialog.

## How Styles Work

Each style includes a configuration object that influences the AI generation:

- **Color Palette** — Defines the dominant colors. When no preview image is available, a gradient is generated from the palette.
- **Artistic Direction** — Guides the overall visual treatment (photorealistic, cinematic, illustrated, anime, etc.)
- **Rendering Approach** — Affects how prompts are constructed for image generation

## Style Categories

Some motion models require specific style categories. For example, the **Seedance 2** motion model is restricted to **animation** styles. If you select a style from a different category, incompatible motion models are automatically switched to the default.

## Style and Script Enhancement

When you use **Enhance Script**, the selected style's configuration is passed to the AI. The enhanced screenplay is tailored to match the style's visual language — for example, a noir style produces darker, moodier descriptions while a vibrant pop-art style produces bold, colorful ones.

### Video Call

Choose **Video Call** for a two-person conversation or a remote group meeting. It uses fixed webcam views, cutting between speakers and listening reactions. Each person has their own room, with the same background, lighting, and framing whenever they reappear.

In your script, name each participant and describe their setting on first appearance. Reuse those names when switching speakers. For example: “Maya speaks from her cream-walled study with an oak bookshelf. Ben replies from his blue-walled office. Return to Maya in the same study.” The default format is landscape (16:9), with one participant filling the frame at a time.
