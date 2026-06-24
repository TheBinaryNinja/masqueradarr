/// <reference types="vite/client" />

// VITE_APP_VERSION carries the Docker image tag, baked into the SPA at build time
// (docker/app.Dockerfile + docker/aio.Dockerfile spa-build stage). vite/client's ImportMetaEnv has no
// index signature, so this augmentation is what lets App.vue read it without a vue-tsc error.
interface ImportMetaEnv {
  readonly VITE_APP_VERSION: string;
}
