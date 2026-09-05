/**
 * Observability boot.
 *
 * Imported as the very first statement of `src/server.ts` so logging is
 * configured before any TanStack Start routes, server functions, or
 * middleware modules load. (LLM analytics needs no boot step — the OTel
 * middleware in `@/lib/observability/ai-otel` initializes lazily per
 * `chat()` call.)
 */

import { configureLogging } from '@/shared/observability/logger';

configureLogging();
