import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Hosted copy lives at assets.openstory.so/stitch-player/demo/.
  // Leave unset for `vite` on port 4187.
  base: process.env.STITCH_DEMO_BASE || '/',
  plugins: [react()],
  server: { port: 4187, strictPort: true },
});
