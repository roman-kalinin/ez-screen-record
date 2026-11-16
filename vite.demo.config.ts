import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Builds the real renderer UI with a fake preload (src/renderer/demo/fake-ez.ts)
// for the animated demo on the landing page. Output goes to site/demo/.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'site/demo'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        demo: resolve(__dirname, 'src/renderer/demo.html'),
        'demo-toolbar': resolve(__dirname, 'src/renderer/demo-toolbar.html'),
      },
    },
  },
});
