import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  // Vidstack ships web components (<media-player>, <media-provider>, …); tell the Vue compiler to treat any
  // `media-*` tag as a custom element instead of trying to resolve it as a Vue component.
  plugins: [vue({ template: { compilerOptions: { isCustomElement: (tag) => tag.startsWith('media-') } } })],
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
