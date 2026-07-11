// TEMP verification-only Vite config (delete after runtime verification). Runs the masqueradarr SPA on :5199
// against the isolated scratch server on :3001. Mirrors vite.config.ts incl. the media-* custom-element rule
// Vidstack needs.
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('media-') } } })],
  server: {
    port: 5199,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true, ws: true },
    },
  },
});
