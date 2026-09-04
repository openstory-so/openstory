# Contributing to OpenStory

Thanks for your interest in contributing! OpenStory is MIT-licensed and we welcome contributions of all kinds — bug reports, feature requests, documentation improvements, and code.

For detailed architecture documentation, see [CLAUDE.md](CLAUDE.md).

## Getting Started

### Prerequisites

- **Bun** >= 1.3.9 — [install](https://bun.com/docs/installation)

No Docker or external services — local dev runs the full stack (D1, R2, Workflows, Durable Objects) inside Workerd via Miniflare.

### Setup

```bash
# Fork and clone
gh repo fork openstory-so/openstory --clone
cd openstory

# Install and run
bun install
bun dev
```

`bun dev` handles everything: it generates `.env.local` (with auth/encryption secrets) on first run, migrates and seeds the local database, and starts the dev server. To use AI generation features, run `bun setup` to add `FAL_KEY` and `OPENROUTER_KEY` (or paste them into `.env.local`).

Open [http://localhost:3000](http://localhost:3000) — you should see the app running.

## Development Workflow

### Branch Naming

Branch names **must** follow the pattern `<issue-number>-feature-name`:

```
393-improve-readme
142-fix-frame-export
57-add-motion-controls
```

Lefthook automatically tags commits with the issue number extracted from the branch name.

### Finding Work

- Look for issues labeled [`good first issue`](https://github.com/openstory-so/openstory/labels/good%20first%20issue) or [`help wanted`](https://github.com/openstory-so/openstory/labels/help%20wanted)
- For larger changes, open an issue first to discuss the approach

### Daily Development

`bun dev` runs env bootstrap, DB migration + seeding, and the dev server. For billing work, `bun dev:all` also starts the Stripe listener (skipped when `STRIPE_SECRET_KEY` isn't set).

Key commands:

| Command         | Description                                                     |
| --------------- | --------------------------------------------------------------- |
| `bun dev`       | Start the app dev services                                      |
| `bun dev:all`   | Same as `bun dev` plus the Stripe listener                      |
| `bun run build` | Build for production (**not** `bun build` — that's the bundler) |
| `bun typecheck` | Type-check with tsgo                                            |
| `bun run test`  | Run unit tests (Vitest)                                         |
| `bun test:e2e`  | Run Playwright end-to-end tests                                 |

## Code Quality

### Automated on Commit

Lefthook runs on every commit:

- **oxlint** — linting (type-aware)
- **oxfmt** — formatting
- **tsgo** — type checking

on staged files. If the hooks fail, fix the issues before committing.

### Manual Checks

```bash
bun lint          # Lint the codebase
bun lint:fix      # Lint and auto-fix
bun format        # Format with oxfmt
bun format:check  # Check formatting without writing
bun typecheck     # Type-check with tsgo
bun dead-code     # Find unused exports with Knip
```

### CI

GitHub Actions runs the full quality gate on every pull request: lint, format, typecheck, unit tests, and E2E tests. All checks must pass before merging.

## Testing

### Unit Tests

```bash
bun run test          # Run all tests (NOT `bun test` — that's Bun's built-in runner)
bun test:watch        # Watch mode
bun test:coverage     # With coverage report
```

- Framework: [Vitest](https://vitest.dev)
- Location: `__tests__/` directories alongside routes, or `.test.ts` next to modules
- Focus on business logic — not React components

### End-to-End Tests

```bash
bun test:e2e          # Run Playwright tests (hermetic — workflows skipped)
bun test:e2e:ui       # Interactive Playwright UI
bun test:e2e:full     # Full pipeline: real Cloudflare Workflows, fal+LLM via aimock fixtures
```

- Location: `e2e/tests/`
- Uses Playwright with a dedicated test database
- LLM (OpenRouter) and fal.ai traffic is served by [aimock](https://github.com/CopilotKit/aimock) on port 4010 — fal.ai goes through a custom handler mounted at `/fal`

#### Refreshing recorded e2e fixtures

The full-pipeline test (`e2e/tests/full-sequence.spec.ts`) replays AI responses from `e2e/fixtures/recorded/`. To capture or refresh them:

```bash
# With real keys in .env.local (FAL_KEY, OPENROUTER_KEY):
bun test:e2e:full:record
```

Commit the generated fixtures alongside any code change that alters AI prompts or model selection.

> See the [Testing](CLAUDE.md#testing) section in CLAUDE.md for mock patterns and database testing conventions.

## Database Changes

1. Modify schema files in `src/lib/db/schema/`
2. Generate migration: `bun db:generate`
3. Apply migration: `bun db:migrate:local` (also runs as part of `bun dev`)

**Important:**

- **Never** write migration SQL manually — always use Drizzle Kit
- Use **ULID** primary keys (not UUID)
- Types are auto-inferred from the schema by Drizzle
- Database access is only allowed in server handlers (never in components)

## Code Conventions

A brief summary — see [CLAUDE.md](CLAUDE.md) for full patterns with examples.

### TypeScript

- Use `type` instead of `interface`
- No `any` or `unknown` — keep proper types
- Throw errors instead of returning success booleans

### Files

- kebab-case filenames (e.g., `frame-editor.tsx`)
- Named exports (no default exports)

### React

- **Data fetching:** TanStack Query + Suspense (no `useState` + `useEffect` for data)
- **Styling:** shadcn/ui base components + Tailwind for layout only (flex, gap, grid)
- **Loading states:** inline `<Skeleton />` fallbacks (no separate skeleton components)
- **Complex state:** `useReducer` with vanilla TS reducer (not multiple `useState`)
- **Forms:** TanStack Query mutations + Zod validation

### Server

- DB access only in server handlers — never in components
- Follow the [server handler pattern](CLAUDE.md#server-handler-pattern) in CLAUDE.md
- Trigger workflows via `triggerWorkflow()` from `@/lib/workflow/client` — never direct `fetch()` calls

## Pull Request Process

1. **Branch from `main`** using the `<issue>-feature` naming convention
2. **Run quality checks locally** before pushing:
   ```bash
   bun lint && bun format:check && bun typecheck && bun run test
   ```
3. **Push and create a PR** — fill out the PR template completely
4. **Include `Closes #<issue>`** in the PR description so the issue auto-closes on merge
5. **CI must pass** — lint, format, typecheck, tests, and E2E
6. **PR previews** — Cloudflare automatically deploys a preview with a dedicated database

## Reporting Issues

### Bug Reports

Use the [bug report template](https://github.com/openstory-so/openstory/issues/new?template=bug_report.yml) and include:

- Steps to reproduce
- Expected vs actual behavior
- Browser/OS/Bun version

### Feature Requests

Use the [feature request template](https://github.com/openstory-so/openstory/issues/new?template=feature_request.yml):

- Describe the problem before proposing a solution
- Include use cases and context

### Large Changes

For significant architectural changes or new features, **open an issue first** to discuss the approach before writing code. This avoids wasted effort if the direction doesn't align with the project's goals.
