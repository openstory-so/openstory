<p align="center">
  <img src=".github/openstory-logo.svg" alt="OpenStory" width="275" />
</p>

<h1 align="center">OpenStory</h1>

<p align="center">
  Transform scripts into styled video productions using AI.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <a href="https://github.com/openstory-so/openstory/actions/workflows/test.yml"><img src="https://github.com/openstory-so/openstory/actions/workflows/test.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/bun-%3E%3D1.3.9-f9f1e1" alt="Bun >= 1.3.9" />
</p>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openstory-so/openstory)

OpenStory takes a script and produces a sequence of AI-generated frames — images, motion video, audio — with consistent style across every scene. Teams collaborate on shared libraries of characters, locations, and visual styles, and the platform handles the heavy lifting of prompt engineering, generation, and compositing.

## Features

- **Script analysis** — paste a script and get an automatic scene breakdown with camera angles, mood treatments, and continuity tracking
- **AI image generation** — generate scene images via [Fal.ai](https://fal.ai) with multiple model options
- **Image-to-video motion** — turn still frames into motion video clips
- **Style consistency** — characters, locations, color palettes, and lighting carry across scenes automatically
- **Team workspaces** (coming soon) — shared libraries of styles, characters, VFX, and audio
- **Passkey authentication** — passwordless sign-in via Better Auth
- **Edge deployment** — runs on Cloudflare Workers with global CDN

## Tech Stack

| Category       | Tools                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Runtime**    | [Bun](https://bun.com)                                                                                                                                                                        |
| **Framework**  | [TanStack Start](https://tanstack.com/start) + [TanStack Router](https://tanstack.com/router) + [Vite](https://vite.dev)                                                                      |
| **Database**   | [Drizzle ORM](https://orm.drizzle.team) + [Cloudflare D1](https://developers.cloudflare.com/d1) (SQLite)                                                                                      |
| **AI**         | [TanStack AI](https://tanstack.com/ai) + [Fal.ai](https://fal.ai) + [OpenRouter](https://openrouter.ai) + [PostHog](https://posthog.com) (LLM observability)                                  |
| **Workflows**  | [Cloudflare Workflows](https://developers.cloudflare.com/workflows) (durable execution)                                                                                                       |
| **Realtime**   | [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects) (SSE progress updates)                                                                                        |
| **Storage**    | [Cloudflare R2](https://developers.cloudflare.com/r2) (S3-compatible)                                                                                                                         |
| **Auth**       | [Better Auth](https://www.better-auth.com)                                                                                                                                                    |
| **Styling**    | [Tailwind v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)                                                                                                                   |
| **Quality**    | [oxlint](https://oxc.rs/docs/guide/usage/linter) + [oxfmt](https://oxc.rs) + [tsgo](https://github.com/microsoft/typescript-go) + [Lefthook](https://lefthook.dev) + [Knip](https://knip.dev) |
| **Testing**    | [Vitest](https://vitest.dev) + [Playwright](https://playwright.dev)                                                                                                                           |
| **Deployment** | [Cloudflare Workers](https://developers.cloudflare.com/workers)                                                                                                                               |

> See [CLAUDE.md](CLAUDE.md) for full architecture documentation, server handler patterns, workflow patterns, and React conventions.

## Prerequisites

- **Bun** >= 1.3.9 — [install](https://bun.com/docs/installation)

That's it. No Docker, no external database, no Cloudflare account — local dev runs the full stack (D1, R2, Workflows, Durable Objects, email) inside Workerd via Miniflare.

## Quick Start

```bash
git clone https://github.com/openstory-so/openstory.git
cd openstory
bun install
bun dev
```

Open [http://localhost:3000](http://localhost:3000).

`bun dev` does everything: it generates `.env.local` (with auth/encryption secrets) on first run, migrates and seeds the local database, and starts the dev server.

To use AI generation features you need two API keys — run `bun setup` to add them interactively, or paste them into `.env.local`:

- `FAL_KEY` — [fal.ai](https://fal.ai/dashboard/keys) for image, video & audio generation
- `OPENROUTER_KEY` — [OpenRouter](https://openrouter.ai/settings/keys) for LLM script analysis

See [`.env.example`](.env.example) for all optional configuration (Google OAuth, Stripe, PostHog, remote R2).

## Scripts

### Development

| Command         | Description                                                |
| --------------- | ---------------------------------------------------------- |
| `bun dev`       | Bootstrap env, migrate + seed DB, start dev server         |
| `bun setup`     | Interactive setup — add AI keys (`--prod` for deployments) |
| `bun storybook` | Start Storybook on port 6006                               |

### Quality

| Command            | Description                      |
| ------------------ | -------------------------------- |
| `bun lint`         | Lint with oxlint (type-aware)    |
| `bun lint:fix`     | Lint and auto-fix                |
| `bun format`       | Format with oxfmt                |
| `bun format:check` | Check formatting without writing |
| `bun typecheck`    | Type-check with tsgo             |
| `bun dead-code`    | Find unused exports with Knip    |

### Testing

| Command             | Description                        |
| ------------------- | ---------------------------------- |
| `bun run test`      | Run unit tests (Vitest)            |
| `bun test:watch`    | Run tests in watch mode            |
| `bun test:coverage` | Run tests with coverage            |
| `bun test:e2e`      | Run Playwright end-to-end tests    |
| `bun test:e2e:ui`   | Run Playwright with interactive UI |

### Database

| Command                | Description                                       |
| ---------------------- | ------------------------------------------------- |
| `bun db:generate`      | Generate migrations from schema changes           |
| `bun db:migrate:local` | Apply migrations (also runs as part of `bun dev`) |
| `bun db:studio:local`  | Open Drizzle Studio against the local database    |

### Build & Deploy

| Command             | Description                                         |
| ------------------- | --------------------------------------------------- |
| `bun run build`     | Build for production (note: not `bun build`)        |
| `bun setup --prod`  | Interactive production setup + deploy               |
| `bun cf:deploy:prd` | Manual production deploy (build → migrate → deploy) |

## Project Structure

```
src/
  components/     # React UI components (shadcn/ui based)
  functions/      # Server functions (all business logic endpoints)
  lib/            # Shared utilities, services, types
    ai/           # AI model configs and prompt schemas
    db/           # Database schema and clients (Drizzle)
    services/     # Core business services
    workflows/    # Cloudflare Workflows durable definitions
  routes/         # TanStack Router file-based routes
    api/          # Webhooks: workflows and auth only
    _app/         # App shell (anonymous-browsable; actions gated behind login)
e2e/              # Playwright end-to-end tests
scripts/          # CLI utilities and setup
```

> See [CLAUDE.md](CLAUDE.md) for detailed architecture, data model, server handler patterns, and code conventions.

## Deployment

**Cloudflare Workers** — edge runtime, R2 storage, D1 database, global CDN.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/openstory-so/openstory)

The deploy button clones the repo into your Cloudflare account, provisions the resources declared in [`wrangler.jsonc`](wrangler.jsonc), and sets up CI. For a guided setup from your own clone, run `bun setup --prod`.

**CI/CD:** Cloudflare Workers Builds auto-deploys on push to `main` — the same mechanism deploy-button clones use. Pull requests get GitHub Actions preview deployments with dedicated D1 databases.

> See the [Platform & Deployment](CLAUDE.md#platform--deployment) section in CLAUDE.md for environment variable configuration and platform detection.

## Contributing

We'd love your help building OpenStory! Whether it's fixing a bug, adding a feature, improving docs, or just sharing ideas — all contributions are welcome. Check out the issues labeled [`good first issue`](https://github.com/openstory-so/openstory/labels/good%20first%20issue) for a great place to start.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, branch naming, code quality, and the pull request process.

## License

[MIT](LICENSE)
