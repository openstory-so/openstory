# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Structure

This is a **bun monorepo** with workspaces for future backend services. Currently contains:
- `apps/frontend/` - Next.js 15 application (main app)
- Root package.json - Workspace configuration only

**Important**: The repository is undergoing restructuring (branch: `102-task-restructure-repo-to-setup-elysia`) to support future Elysia backend services alongside the existing Next.js frontend.

## Common Commands

All development commands run from the **frontend workspace**:

```bash
# Navigate to frontend workspace
cd apps/frontend

# Development
bun dev              # Start Next.js dev server with Turbopack
bun build            # Build production app
bun start            # Start production server

# Code Quality
bun biome check .             # Check linting/formatting
bun biome format .            # Format code
bun biome check --write .     # Fix linting and formatting issues

# Testing
bun test                      # Run tests
bun test --watch              # Watch mode
bun test --coverage           # With coverage
bun test path/to/file.test.ts # Single test file

# Type Checking
bun tsc --noEmit             # Type check without building

# Supabase (Local Database)
bunx supabase start          # Start local Supabase stack
bunx supabase stop           # Stop local Supabase
bunx supabase db reset       # Reset database to migrations
bun supabase:types          # Generate TypeScript types from DB schema

# QStash (Job Queue Development)
bun qstash:dev              # Start local QStash tunnel for webhooks

# Environment Setup
bun setup:env               # Create .env.development.local from Supabase status
```

## Architecture Overview

**Velro** is an AI-powered cinematic content creation platform that transforms scripts into consistent, styled video productions.

### Tech Stack
- **Frontend**: Next.js 15 (App Router), React 19, TypeScript 5
- **Runtime**: Bun (package manager + test runner)
- **Database**: Supabase PostgreSQL (backend-only access, no RLS)
- **Auth**: BetterAuth (email/password + anonymous sessions)
- **Queue**: QStash (Upstash) for async AI generation jobs
- **Storage**: Supabase Storage (generated images/videos)
- **UI**: shadcn/ui + Tailwind CSS 4
- **State**: TanStack Query v5 (server state) + reducers (complex UI state)
- **Testing**: Bun test (Jest-compatible)
- **Linting**: Biome (replaces ESLint + Prettier)

### Key Architectural Decisions

1. **Backend-Only Database Access**
   - No RLS on Supabase
   - All database operations via Server Actions or API routes
   - Single service account for all backend access
   - Clearer security model, avoids RLS complexity

2. **Anonymous-First User Flow**
   - Users create content without signup
   - Anonymous sessions tracked via BetterAuth
   - Prompted to save work via email login
   - Data transfers to authenticated account on signup

3. **Team-Based Ownership**
   - All resources belong to teams (sequences, styles, characters)
   - Users are team members with roles (owner, admin, member)
   - Database triggers auto-create teams for new users

4. **Script-Driven Generation**
   - Everything generates from the script
   - AI analyzes script → creates frames → generates images → adds motion
   - Style Stacks ensure consistency across different AI models

### Core Data Model

```
teams (owns all resources)
  ├── users (team members)
  ├── sequences (video projects)
  │   ├── script (text)
  │   ├── storyboard (JSON)
  │   └── frames (shots)
  │       ├── thumbnail (image URL)
  │       ├── motion (video URL)
  │       └── references (characters, vfx, audio)
  └── libraries
      ├── styles (Style Stacks)
      ├── characters (LoRA models)
      ├── vfx (effects presets)
      └── audio (sound/music)
```

### Directory Structure

```
apps/frontend/src/
├── app/
│   ├── actions/          # Server Actions (DB operations)
│   ├── api/v1/           # REST API endpoints
│   ├── sequences/        # Sequence pages
│   └── (auth)/           # Auth pages
├── components/
│   ├── ui/               # shadcn/ui components
│   ├── sequence/         # Storyboard, frame editor
│   ├── sequence-flow/    # Multi-step creation flow
│   └── layout/           # App layout components
├── hooks/                # TanStack Query hooks
├── lib/
│   ├── ai/               # AI model integrations
│   ├── fal/              # Fal.ai SDK wrapper
│   ├── qstash/           # QStash job queue
│   ├── supabase/         # Supabase clients + types
│   ├── auth/             # BetterAuth utilities
│   ├── schemas/          # Zod validation schemas
│   └── services/         # Business logic services
└── types/                # Shared TypeScript types

supabase/
├── migrations/           # Database migrations (versioned)
└── seed.sql             # Seed data
```

## Development Workflow

### First-Time Setup
1. Install dependencies: `bun install` (from root)
2. Navigate to frontend: `cd apps/frontend`
3. Setup environment: `bun setup:env` (requires QStash token from Upstash)
4. Start Supabase: `bunx supabase start`

### Daily Development (3 Terminal Setup)
1. **Terminal 1 - Supabase**: `bunx supabase:start` (if not running)
2. **Terminal 2 - QStash**: `bun qstash:dev` (for async job testing)
3. **Terminal 3 - Next.js**: `bun dev`

### Before Committing
```bash
bun tsc --noEmit          # Check TypeScript
bun biome check .         # Check linting/formatting
bun test                  # Run test suite
```

**Automatic Issue Tagging**: Branches starting with digits (e.g., `102-feature-name`) automatically tag commits with issue numbers. Example: "Fix bug" becomes "Fix bug (#102)". Handled by lefthook commit-msg hook via `scripts/add-issue-number.sh`.

## Code Patterns

### Server Actions Pattern
Located in `apps/frontend/src/app/actions/*/index.ts`:

```typescript
"use server";

import { z } from "zod";
import { getCurrentUser } from "@/app/actions/user";
import { createServerClient } from "@/lib/supabase/server";

const inputSchema = z.object({
  name: z.string().min(1),
});

export type CreateInput = z.infer<typeof inputSchema>;

export async function createAction(input: CreateInput) {
  try {
    // 1. Authenticate with BetterAuth
    const userResult = await getCurrentUser();
    if (!userResult.success || !userResult.data) {
      return { success: false, error: "Authentication required" };
    }

    const { user } = userResult.data;

    // 2. Validate input
    const validatedInput = inputSchema.parse(input);

    // 3. Database operations via Supabase admin client
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from('table')
      .insert({ ...validatedInput, user_id: user.id })
      .select()
      .single();

    if (error) throw error;

    return { success: true, data };
  } catch (error) {
    console.error("[createAction] Error:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
```

### API Route Pattern
Located in `apps/frontend/src/app/api/v1/*/route.ts`:

```typescript
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { handleApiError } from "@/lib/errors";
import { authenticateApiRequest } from "@/lib/auth/api-utils";

const requestSchema = z.object({
  name: z.string().min(1),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // 1. Await params (Next.js 15 requirement)
    const { id } = await params;

    // 2. Check authentication
    const authResult = await authenticateApiRequest(request);
    if (!authResult.authenticated) {
      return NextResponse.json(
        { error: authResult.error || "Unauthorized" },
        { status: 401 }
      );
    }

    // 3. Validate request body
    const body = await request.json();
    const validatedData = requestSchema.parse(body);

    // 4. Execute business logic via server actions
    const result = await someAction(validatedData);

    // 5. Return standardized response
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const velroError = handleApiError(error);
    return NextResponse.json(
      { error: velroError.message },
      { status: velroError.statusCode }
    );
  }
}
```

### TanStack Query Hook Pattern
Located in `apps/frontend/src/hooks/use-*.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import { getEntityAction } from "@/app/actions/entity";

// Centralized query keys
export const entityKeys = {
  all: ["entities"] as const,
  lists: () => [...entityKeys.all, "list"] as const,
  list: (filter?: string) => [...entityKeys.lists(), filter] as const,
  details: () => [...entityKeys.all, "detail"] as const,
  detail: (id: string) => [...entityKeys.details(), id] as const,
};

// React hook
export function useEntity(id: string) {
  return useQuery({
    queryKey: entityKeys.detail(id),
    queryFn: async () => {
      const result = await getEntityAction(id);
      if (!result.success) throw new Error(result.error);
      return result.data;
    },
  });
}
```

## Testing Guidelines

### Framework
- Use **Bun test** (NOT Vitest or Jest)
- Tests use `bun:test` APIs (similar to Jest)
- Place API tests in `__tests__/` directories
- Place utility tests next to the module (`service.test.ts`)

### Mock Management (Critical for Bun)
```typescript
import { test, expect, mock } from "bun:test";

// Create fresh mock for each test
const mockCreateClient = mock(() => ({ /* implementation */ }));

mock.module("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

beforeEach(() => {
  mockCreateClient.mockClear(); // Clear between tests
});
```

### Database Types
- Import from `@/types/database` (NOT `src/lib/supabase/gen.types.ts`)
- Types auto-generated via `bun supabase:types`
- Generated on `bun install` via postinstall hook
- File is gitignored (always matches local DB schema)

## Important Notes

### Database Types
- **Auto-generated**: Types regenerate on `bun install` via postinstall
- **Local-only**: `gen.types.ts` is gitignored
- **Manual regen**: Run `bun supabase:types` if needed
- **Import from**: `@/types/database` (convenience exports)

### Style Stacks
The core innovation - JSON presets that maintain consistent artistic style across different AI models. Model-agnostic and auto-adapt parameters.

### QStash Job Queue
All AI generation (images, videos) runs asynchronously via QStash webhooks:
1. User triggers generation → API creates QStash job
2. QStash worker processes job → calls AI model API
3. Worker saves result to storage → updates database
4. Realtime notification → UI updates via Supabase Realtime

### Anonymous User Flow
1. User creates content without signup (anonymous session)
2. Prompted to save work via email login
3. BetterAuth `onLinkAccount` callback migrates data
4. Database trigger creates team and membership

## Future Backend (Elysia)

The repository is being restructured to support future backend services:
- **Current**: Next.js handles everything (frontend + API + Server Actions)
- **Future**: Separate Elysia backend services in `apps/backend/`
- **Reason**: Better performance for high-throughput AI job processing
- **Pattern**: Bun-native services using Elysia framework

When backend is added, this CLAUDE.md will be updated with backend-specific commands and patterns.
