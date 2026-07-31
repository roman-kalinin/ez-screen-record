import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Renderer-only build. The Electron main process is compiled separately by tsc
// (see tsconfig.main.json) because it needs CommonJS + Node builtins.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './', // relative paths so file:// loading works in the packaged app
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        // Each window gets its own HTML entry point.
        main: resolve(__dirname, 'src/renderer/index.html'),
        overlay: resolve(__dirname, 'src/renderer/overlay.html'),
        camera: resolve(__dirname, 'src/renderer/camera.html'),
        toolbar: resolve(__dirname, 'src/renderer/toolbar.html'),
      },
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
});
