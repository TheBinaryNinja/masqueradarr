import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { installAuthFetch } from './authFetch';
import './styles.css';

// Attach the Bearer auth token to every fetch. Must run before the app mounts (and therefore before any
// data helper fires). Shared with the standalone Ultimate Player entry — see authFetch.ts.
installAuthFetch();

createApp(App).use(router).mount('#app');
