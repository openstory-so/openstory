import { withThemeByClassName } from '@storybook/addon-themes';
import type { Decorator, Preview } from '@storybook/react-vite';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RealtimeProvider } from '../src/lib/realtime/client';
import { mswLoader } from 'msw-storybook-addon/csf3';
import { setupWorker } from 'msw/browser';
import { handlers } from '../src/lib/mocks/handlers';

import '../src/styles/global.css';

/*
 * Initializes MSW with our API handlers
 * See https://github.com/mswjs/msw-storybook-addon#configuring-msw
 * to learn how to customize it
 */

// Create a client for Storybook
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

const withProviders: Decorator = (Story) => (
  <QueryClientProvider client={queryClient}>
    <RealtimeProvider>
      <Story />
    </RealtimeProvider>
  </QueryClientProvider>
);

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },

    backgrounds: {
      disabled: true,
    },

    // Adds default padding around components
    layout: 'padded',

    viewport: {},

    // Configure MSW handlers globally for all stories
    msw: {
      handlers,
    },

    a11y: {
      // 'todo' - show a11y violations in the test UI only
      // 'error' - fail CI on a11y violations
      // 'off' - skip a11y checks entirely
      test: 'todo',
    },
  },

  loaders: [
    mswLoader(async () => {
      const worker = setupWorker();
      await worker.start({ onUnhandledRequest: 'bypass' });
      return worker;
    }),
  ],

  decorators: [
    withProviders,
    withThemeByClassName({
      themes: {
        light: '',
        dark: 'dark',
      },
      defaultTheme: 'dark',
    }),
  ],

  initialGlobals: {
    viewport: {
      value: 'responsive',
      isRotated: false,
    },
  },
};

export default preview;
