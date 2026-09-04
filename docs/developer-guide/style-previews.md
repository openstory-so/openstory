---
title: Style Previews & Thumbnails
description: Generate candidate preview images per style, score them comparatively, and upload the originals + resized previews + chosen thumbnail to R2
section: Developer Guide
order: 7
---

Each style shows a still **thumbnail** (and larger preview) in the UI. These are
produced independently of the [Style Sample Videos](./style-sample-videos.md)
pipeline — they are _not_ the video's starting frames.

The pipeline is three scripts:
`scripts/generate-style-previews.ts` → `scripts/score-style-previews.ts` →
`scripts/upload-style-previews-to-r2.ts`.

## Prerequisites

- `FAL_KEY` — preview image generation. Without it `generate` is a dry-run that just prints prompts.
- `OPENROUTER_KEY` — the comparative vision scorer.
- Cloudflare creds for upload — the default path shells out to `wrangler`.

## Candidate scenes

Each style gets **3 candidate scenes**, chosen by style kind so we never force
"a character portrait" onto a product-on-white style:

- **People / narrative styles** → `character`, `environment`, `action`
- **Product / object styles** (ecommerce, food, automotive, product-led commercial) → `hero`, `detail`, `context`

The split is decided by `scenesForStyle` (`PRODUCT_CATEGORIES`, or
`category === 'commercial'` with a `product` first use-case → product set,
otherwise people set).

## Steps

### 1. Generate candidate previews

```bash
FAL_KEY=… bun scripts/generate-style-previews.ts
```

Generates all 3 scenes for every style into `preview/{slug}/{scene}.webp`
(text-to-image via each style's recommended image model, run through
`buildStyledImagePrompt`). Runs a concurrency pool (`MAX_CONCURRENT = 8`) with up
to `MAX_RETRIES = 2` retries per failed task. Filter to one style with
`--filter "<name or slug>"`, or one scene with `--scene <name>`.

Without `FAL_KEY` it prints the prompts and exits (dry-run).

### 2. Score them comparatively + pick each style's thumbnail

```bash
OPENROUTER_KEY=… bun scripts/score-style-previews.ts
```

**Comparative** scoring: all of a style's candidate scenes are sent in **one**
vision call so the model ranks them against each other and picks the one that
best _showcases_ the style — far more discriminating than scoring each image in
isolation (which over-rewarded generic portraits). It flags the same failure
modes as the video gate: literal-medium renders, multi-frame/panel grids,
malformed anatomy, stray text.

Outputs (report-only — never deletes anything):

- `preview/_scores.json` — full per-scene verdicts.
- `preview/_thumbnails.json` — `{ slug: bestScene }`, the model's pick per style. Feed this to the uploader via `--thumbnail-map`.
- Console: styles ranked worst-first + a re-roll list (anything below `--threshold`, or with a hard flag on the chosen scene). Exits non-zero if any style fails — useful as a gate.

Flags: `--filter "<name>"`, `--scene <name>`, `--model <id>` (default
`google/gemini-3.7-flash`), `--threshold <n>`.

> LLM anatomy detection is imperfect — treat anatomy flags as a strong hint, not
> gospel, and spot-check the chosen thumbnails.

For any style flagged for re-roll, re-run step 1 with `--filter`/`--scene` to
regenerate just those scenes, then re-score.

### 3. Upload to R2

```bash
bun scripts/upload-style-previews-to-r2.ts --dry-run                          # preview only, no uploads
bun scripts/upload-style-previews-to-r2.ts --thumbnail-map=preview/_thumbnails.json --yes
```

For each scene it uploads the original plus a **512px preview**, and for the
**chosen** scene a **256px thumbnail**, as WebP. Thumbnail selection, in order of
precedence:

- `--thumbnail-map=preview/_thumbnails.json` — per-style best scene from step 2 (recommended).
- `--thumbnail-scene=<name>` — force one scene for every style.
- Interactive — prompts you to choose per style (the default with no flag).
- Fallback when a style is missing from the map: `character`.

Add `--yes` to skip the confirm prompt. The default uploader is `wrangler`; pass
`--s3` only with **unscoped** `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` (scoped keys 403 against `openstory-public-assets`).
`UPLOAD_CONCURRENCY` defaults to 12 (kept lower for the per-file wrangler path).

## Outputs

```
preview/
  {slug}/{scene}.webp     # candidate previews (character|environment|action or hero|detail|context)
  _scores.json            # per-scene verdicts (step 2)
  _thumbnails.json        # { slug: bestScene } (step 2)
```

R2 keys in the public bucket (`https://{VITE_R2_PUBLIC_ASSETS_DOMAIN}/…`):

```
styles/{slug}/{scene}.webp           # original
styles/{slug}/{scene}-preview.webp   # 512px
styles/{slug}/thumbnail.webp         # 256px, the chosen scene
```

The local `preview/{slug}` folder name matches the R2 `styles/{slug}` path —
both use the canonical slug rule in `src/lib/style/style-slug.ts`, shared with
the sample-video URLs.

## TL;DR

```
generate  →  score (pick thumbnails)  →  re-roll any fails  →  upload --thumbnail-map
```

## package.json alias

```bash
bun run setup:previews    # generate-style-previews.ts && upload-style-previews-to-r2.ts
```

Note the alias chains **generate → upload** and skips scoring. For the
score-driven thumbnail pick, run the three steps explicitly as above.
