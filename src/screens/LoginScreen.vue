<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '../composables/useAuth';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';

const router = useRouter();
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

async function handleLogin() {
    error.value = '';
    if (!username.value.trim() || !password.value) {
        error.value = 'Please enter your username and password';
        return;
    }

    loading.value = true;
    try {
        const res = await login(username.value.trim(), password.value);
        if (res.success) {
            router.push('/dashboard');
        } else {
            error.value = res.error || 'Invalid username or password';
        }
    } catch (err) {
        error.value = 'A connection error occurred';
    } finally {
        loading.value = false;
    }
}
</script>

<template>
    <div class="login-container">
        <div class="login-card card">
            <div class="login-header">
                <div class="logo-wrap">
                    <span class="logo-dot" />
                    <span class="logo-text">TVApp2 Login</span>
                </div>
                <h3>Welcome back</h3>
                <p class="muted text-xs">Sign in to manage your IPTV feeds and channels.</p>
            </div>

            <form @submit.prevent="handleLogin" class="login-form">
                <div v-if="error" class="error-banner">
                    <Icon name="file" :size="14" />
                    <span>{{ error }}</span>
                </div>

                <div class="form-group">
                    <label for="username">Username</label>
                    <div class="input-wrap">
                        <Icon name="settings" :size="14" />
                        <input id="username" v-model="username" type="text" placeholder="Enter username" required autocomplete="username" />
                    </div>
                </div>

                <div class="form-group">
                    <label for="password">Password</label>
                    <div class="input-wrap">
                        <Icon name="file" :size="14" />
                        <input id="password" v-model="password" type="password" placeholder="Enter password" required autocomplete="current-password" />
                    </div>
                </div>

                <Btn type="submit" variant="primary" :disabled="loading" style="width: 100%; justify-content: center; height: 38px; margin-top: 10px;">
                    <template v-slot:default>
                        <span v-if="loading">Signing in...</span>
                        <span v-else>Sign In</span>
                    </template>
                </Btn>
            </form>
        </div>
    </div>
</template>

<style scoped>
.login-container {
    display: grid;
    place-items: center;
    min-height: 100vh;
    background: var(--bg-0);
    padding: 20px;
}
.login-card {
    width: 100%;
    max-width: 400px;
    padding: 32px var(--pad-card);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
    border-color: var(--hairline-strong);
    background: linear-gradient(135deg, var(--bg-1) 0%, var(--bg-0) 100%);
    backdrop-filter: blur(10px);
}
.login-header {
    text-align: center;
    margin-bottom: 24px;
}
.logo-wrap {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
}
.logo-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 12px var(--accent);
}
.logo-text {
    font-size: 20px;
    font-weight: 700;
    color: var(--accent-hi);
    letter-spacing: -0.02em;
}
.login-header h3 {
    margin: 8px 0 4px;
    font-size: 18px;
    font-weight: 600;
}
.login-header p {
    color: var(--text-2);
}
.login-form {
    display: flex;
    flex-direction: column;
    gap: 16px;
}
.form-group {
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.form-group label {
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text-1);
}
.input-wrap {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 38px;
    padding: 0 12px;
    border-radius: var(--radius-s);
    border: 1px solid var(--hairline);
    background: var(--bg-2);
    color: var(--text-0);
    transition: border-color .15s, box-shadow .15s;
}
.input-wrap:focus-within {
    border-color: oklch(0.82 0.13 220 / 0.5);
    box-shadow: 0 0 0 3px var(--accent-soft);
}
.input-wrap input {
    flex: 1;
    background: transparent;
    border: 0;
    padding: 0;
    min-width: 0;
    outline: none;
}
.input-wrap input::placeholder {
    color: var(--text-3);
}
.input-wrap svg {
    color: var(--text-2);
    flex: none;
}
.error-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: oklch(0.70 0.18 25 / 0.12);
    border: 1px solid oklch(0.70 0.18 25 / 0.3);
    border-radius: var(--radius-s);
    color: var(--bad);
    font-size: var(--fs-sm);
}
.text-xs {
    font-size: 11px;
}
</style>
