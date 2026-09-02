/**
 * Test setup file — loaded via vitest.config.ts setupFiles.
 */

import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from '@/shared/mocks/server';

// Enable API mocking before all tests
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'bypass' });
});

// Reset request handlers after each test
afterEach(() => {
  server.resetHandlers();
});

// Clean up after all tests
afterAll(() => {
  server.close();
});
