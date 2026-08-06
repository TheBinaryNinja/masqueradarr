import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // Vidstack ships web components (<media-player>, <media-provider>, …); tell the Vue compiler to treat any
  // `media-*` tag as a custom element instead of trying to resolve it as a Vue component.
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('media-') } } })],
  // TWO entry points, not one:
  //   index.html  → the management SPA (#app, hash router, full app shell)
  //   player.html → the Ultimate Player window (#upl, chrome-free, opened via window.open)
  // Everything else stays on Vite's defaults (outDir 'dist', base '/', publicDir 'public'). The absolute
  // '/assets/...' base is what lets player.html be opened from any path. Rollup shares common chunks between
  // the two entries, and because nothing in the SPA imports video.js it lands in a player-only chunk.
  //
  // Adding an entry here is only half the job: docker/app.Dockerfile and docker/aio.Dockerfile copy the HTML
  // files BY NAME, so a new entry must be added to both or it works in dev and 404s in the image.
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        player: fileURLToPath(new URL('./player.html', import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        ws: true, // forward the dulo streamed-login WebSocket upgrade (/api/dulo/login-stream)
      },
    },
  },
});
