import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  // Relative, so a bundle plays from any sub-path (stitch bundle / share).
  base: './',
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('../dist/page', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 900,
  },
});
