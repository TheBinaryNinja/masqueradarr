import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router';
import './styles.css';

// Fetch Interceptor to automatically attach Bearer Auth Token to all requests
const originalFetch = window.fetch;
window.fetch = function (input, init) {
    const token = localStorage.getItem('auth_token');
    if (token) {
        init = init || {};
        init.headers = init.headers || {};
        if (init.headers instanceof Headers) {
            init.headers.set('Authorization', `Bearer ${token}`);
        } else if (Array.isArray(init.headers)) {
            const idx = init.headers.findIndex((h) => h[0].toLowerCase() === 'authorization');
            if (idx !== -1) {
                init.headers.splice(idx, 1);
            }
            init.headers.push(['Authorization', `Bearer ${token}`]);
        } else {
            (init.headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
        }
    }
    return originalFetch(input, init);
};

createApp(App).use(router).mount('#app');
