---
title: Images and Videos
description: Generate a single still or clip from a prompt, without a sequence
section: User Guide
order: 13
---

**Images** and **Videos** are for one-off stills and clips. You type a prompt, pick the same models used in sequences, and the results land in a library you can sort and favorite.

They are not a sequence: there is no script, scene list, or Theatre cut. Use **Sequences** when you want a full film.

## Open a library

- **Images** in the sidebar, or `/images`
- **Videos** in the sidebar, or `/videos`

The gallery is the library. The prompt bar stays at the bottom so you can generate without losing the grid.

## Generate an image

1. Open **Images**
2. Write a prompt, or click **Shuffle** for a sample still
3. On models with an edit endpoint (Flux 2, Nano Banana, GPT Image, Grok Imagine, Seedream…) attach reference stills with the dashed tile — they become `@Image1`… in the prompt
4. Open the settings chip to pick an image model, aspect ratio, and count (1, 2, or 4)
5. Press the arrow (or Ctrl/Cmd+Enter)

Each still is stored as its own item. Sign in first — generate is gated behind login, same as sequences.

## Generate a video

1. Open **Videos**
2. Pick a mode from the dropdown on the left (**Reference to video** is the default):
   - **Text to video** — prompt only
   - **Reference to video** — attach stills (Seedance 9 + 3 clips + 3 audio, Grok Imagine 7, Kling 4 via Kling O3 Pro, Veo 3). Each becomes `@Image1`… / `@Video1`… / `@Audio1`… Type `@` in the prompt to point at one, or at anything in your library — a cast headshot, a location, a generation — and it is attached for you.
   - **Image to video** — a start frame, plus an optional end frame on models that take one (Kling, LTX, Seedance)
3. Add references with the dashed tile. The picker lists your **Generations** (stills and clips), **Sequences** — open one to pick its shots, elements, cast, or locations — **Talent**, **Locations**, and **Audio** uploads. Or drag images onto the prompt bar.
4. Write the prompt, **Shuffle** a sample, or **Draft prompt** — which looks at what you attached and writes a prompt that uses the tokens. Open the settings chip for model, aspect ratio, every duration the model accepts, and native audio.
5. Press the arrow

The library card plays the clip.

## Paste a scene's request

Open a scene's **Optimised prompt** panel in a sequence, switch to **JSON**, copy, and paste into the Videos prompt bar. The composer rebuilds the references (stills, clips, audio, or start/end frame) and the prompt instead of pasting JSON.

## Sort and keep

- **Newest** and **Oldest** change recency order
- **Favorites** pins items you star on a card
- Open a card to see it full-size, **Download** it, or delete it
