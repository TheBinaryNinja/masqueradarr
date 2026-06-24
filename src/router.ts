import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import { token, currentUser, needsSetup, checkSetup, fetchMe } from './composables/useAuth';

const routes: RouteRecordRaw[] = [
    { path: '/', redirect: '/dashboard' },
    { path: '/setup', name: 'setup', component: () => import('./screens/SetupScreen.vue') },
    { path: '/login', name: 'login', component: () => import('./screens/LoginScreen.vue') },
    { path: '/dashboard', name: 'dashboard', component: () => import('./screens/DashboardScreen.vue') },
    { path: '/active', name: 'active', component: () => import('./screens/ActiveStreamsScreen.vue') },
    { path: '/playlists', name: 'playlists', component: () => import('./screens/PlaylistsScreen.vue') },
    { path: '/playlists/:id', name: 'playlist', component: () => import('./screens/PlaylistDetailScreen.vue'), props: true },
    { path: '/epg-sources', name: 'epg-sources', component: () => import('./screens/EPGSourcesScreen.vue') },
    { path: '/epg-sources/:id', name: 'epg-detail', component: () => import('./screens/EPGDetailScreen.vue'), props: true },
    { path: '/mapping', name: 'mapping', component: () => import('./screens/MappingScreen.vue') },
    { path: '/history', name: 'history', component: () => import('./screens/HistoryMetricsScreen.vue') },
    { path: '/settings', name: 'settings', component: () => import('./screens/SettingsScreen.vue') },
    { path: '/users', name: 'users', component: () => import('./screens/UsersScreen.vue') },
];

export const router = createRouter({ history: createWebHashHistory(), routes });

router.beforeEach(async (to, _from, next) => {
    // 1. Check if first-run setup is required
    if (needsSetup.value === null) {
        await checkSetup();
    }
    if (needsSetup.value) {
        if (to.path !== '/setup') {
            return next('/setup');
        }
        return next();
    }
    if (to.path === '/setup') {
        return next('/login');
    }

    // 2. Fetch user profile if token is present but profile is not loaded
    if (token.value && !currentUser.value) {
        const success = await fetchMe();
        if (!success) {
            if (to.path !== '/login') {
                return next('/login');
            }
            return next();
        }
    }

    const loggedIn = !!currentUser.value;

    // 3. Enforce login route protection
    if (!loggedIn) {
        if (to.path !== '/login') {
            return next('/login');
        }
        return next();
    }

    if (to.path === '/login') {
        return next('/dashboard');
    }

    // 4. Enforce User role restriction (only allowed to view dashboard)
    if (currentUser.value?.role === 'user') {
        if (to.path !== '/dashboard') {
            return next('/dashboard');
        }
    }

    next();
});
