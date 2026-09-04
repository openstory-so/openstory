---
title: Getting Started
description: Set up OpenStory for local development
section: Developer Guide
order: 1
---

OpenStory is an open-source AI video production platform. This guide walks you through setting up a local development environment.

## Prerequisites

- [Bun](https://bun.com/docs/installation) >= 1.3.9
- [Git](https://git-scm.com)

Nothing else. No Docker, no external database, no Cloudflare account — local dev runs the full stack (D1, R2, Workflows, Durable Objects, email) inside Workerd via Miniflare.

## Quick Start

```bash
# Clone the repository
git clone https://github.com/openstory-so/openstory.git
cd openstory

# Install and run
bun install
bun dev
```

`bun dev` does everything: it generates `.env.local` (with auth/encryption secrets) on first run, migrates and seeds the local database, and starts the dev server.

The app will be available at [http://localhost:3000](http://localhost:3000).

## AI Keys

To use AI generation features you need two API keys — run `bun setup` to add them interactively, or paste them into `.env.local`:

- `FAL_KEY` — [fal.ai](https://fal.ai/dashboard/keys) for image, video & audio generation
- `OPENROUTER_KEY` — [OpenRouter](https://openrouter.ai/settings/keys) for LLM script analysis

## Environment Variables

See [`.env.example`](https://github.com/openstory-so/openstory/blob/main/.env.example) for the full list of available environment variables, including optional services like Google OAuth, Stripe, PostHog, and remote R2 storage.

## Database

Local development uses a [Cloudflare D1](https://developers.cloudflare.com/d1) database (Miniflare-backed SQLite) via [Drizzle ORM](https://orm.drizzle.team) — no account or remote service required. `bun dev` migrates and seeds it automatically.

```bash
# Generate migrations from schema changes
bun db:generate

# Apply migrations to the local D1 database
bun db:migrate:local

# Open Drizzle Studio against the local D1 database
bun db:studio:local
```

Production deployments use Cloudflare D1. See the [Cloudflare deployment guide](/docs/deployment/cloudflare) for details.

## Next Steps

- [Creating Sequences](/docs/user-guide/creating-sequences) — Create your first video sequence
- [Working with Scenes](/docs/user-guide/scenes) — Edit and refine individual scenes
- [AI Models](/docs/user-guide/ai-models) — Complete model reference
- [Deploy to Cloudflare](/docs/deployment/cloudflare) — Production deployment guide
