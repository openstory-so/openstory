/**
 * Test setup file — loaded via vitest.config.ts setupFiles.
 */

import { http } from 'msw';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { server } from '@/mocks/server';

// A unit test never reaches modelschemas: its rate limit fails the suite at random.
const noModelschemas = http.all(
  /^https:\/\/([^/]+\.)?modelschemas\.com\//,
  ({ request }) => {
    throw new Error(
      `A unit test fetched ${request.url}; mock it or use a fixture`
    );
  }
);

// Enable API mocking before all tests
beforeAll(() => {
  server.listen({ onUnhandledFrame: 'bypass' });
});

beforeEach(() => {
  server.use(noModelschemas);
});

// Reset request handlers after each test
afterEach(() => {
  server.resetHandlers();
});

// Clean up after all tests
afterAll(() => {
  server.close();
});
