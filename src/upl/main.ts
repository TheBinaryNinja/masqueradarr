// Entry point for the Ultimate Player window (player.html) — the second Vite input alongside the SPA's
// index.html. Deliberately minimal: no vue-router, no App.vue shell, no bootstrapData(). It mounts one
// component that reads its playlist + channel from the URL hash and fetches only what it needs.
import { createApp } from 'vue';
import UplApp from './UplApp.vue';
import { installAuthFetch } from '../authFetch';
import '../styles.css';

// Same Bearer interceptor the SPA installs. localStorage is per-origin, so this same-origin popup already
// shares the session token — there is nothing to hand over from the opener.
installAuthFetch();

createApp(UplApp).mount('#upl');
