import { setupServer } from 'msw/node';
import { handlers } from './handlers';

/**
 * Server-side MSW setup for testing (Bun tests)
 * This intercepts fetch requests in Node.js/Bun environment
 */
export const server = setupServer(...handlers);
