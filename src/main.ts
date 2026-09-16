import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import { installAuthFetch } from './authFetch';
import './styles.css';

installAuthFetch();

createApp(App).use(router).mount('#app');
