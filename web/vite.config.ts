import legacy from '@vitejs/plugin-legacy';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API = `http://localhost:${process.env.PORT || 8080}`;

export default defineConfig({
  plugins: [
    react(),
    legacy({
      // LG webOS 5 (2020 TVs) ships Chromium 68. It passes Vite's "modern browser" check, so the
      // modern bundle itself is compiled down to Chromium 68 with the polyfills it needs.
      modernTargets: ['chrome >= 68', 'safari >= 14', 'firefox >= 90'],
      modernPolyfills: true,
      // Fallback bundle for even older TV browsers (webOS 3/4).
      targets: ['chrome >= 53'],
    }),
  ],
  server: {
    host: true, // reachable from the TV during development too
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
});
