import { Elysia } from "elysia";

/**
 * Simple logging utility
 */
export const logger = {
  debug: (message: string, ...args: unknown[]) => {
    if (process.env.LOG_LEVEL === "debug") {
      console.log(`[DEBUG] ${message}`, ...args);
    }
  },
  info: (message: string, ...args: unknown[]) => {
    console.log(`[INFO] ${message}`, ...args);
  },
  warn: (message: string, ...args: unknown[]) => {
    console.warn(`[WARN] ${message}`, ...args);
  },
  error: (message: string, ...args: unknown[]) => {
    console.error(`[ERROR] ${message}`, ...args);
  },
};

/**
 * Logging plugin for Elysia
 * Logs all incoming requests and their response times
 */
export const loggingPlugin = new Elysia({ name: "logging" })
  .onRequest(({ request, set }) => {
    const start = Date.now();
    // Store start time in set for later use
    (set as any).startTime = start;

    logger.debug(`→ ${request.method} ${request.url}`);
  })
  .onAfterHandle(({ request, set }) => {
    const duration = Date.now() - ((set as any).startTime ?? Date.now());
    logger.info(
      `← ${request.method} ${request.url} - ${set.status ?? 200} (${duration}ms)`
    );
  });

