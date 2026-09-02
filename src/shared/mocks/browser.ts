import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

/**
 * Browser-side MSW worker for Storybook
 * This intercepts fetch requests in the browser and returns mock responses
 */
export const worker = setupWorker(...handlers);
