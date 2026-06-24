<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { setupAdmin } from '../composables/useAuth';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';

const router = useRouter();
const username = ref('admin');
const password = ref('');
const confirmPassword = ref('');
const error = ref('');
const loading = ref(false);

async function handleSetup() {
    error.value = '';
    if (!username.value.trim()) {
        error.value = 'Username is required';
        return;
    }
    if (password.value.length < 6) {
        error.value = 'Password must be at least 6 characters';
        return;
    }
    if (password.value !== confirmPassword.value) {
        error.value = 'Passwords do not match';
        return;
    }

    loading.value = true;
    try {
        const res = await setupAdmin(username.value.trim(), password.value);
        if (res.success) {
            router.push('/dashboard');
        } else {
            error.value = res.error || 'Setup failed';
        }
    } catch (err) {
        error.value = 'A connection error occurred';
    } finally {
        loading.value = false;
    }
}
</script>

<template>
    <div class="setup-container">
        <div class="setup-card card">
            <div class="setup-header">
                <div class="logo-wrap">
                    <span class="logo-dot" />
                    <span class="logo-text">TVApp2 Setup</span>
                </div>
                <h3>Welcome to TVApp2</h3>
                <p class="muted text-xs">Configure your initial Administrator account to get started.</p>
            </div>

            <form @submit.prevent="handleSetup" class="setup-form">
                <div v-if="error" class="error-banner">
                    <Icon name="file" :size="14" />
                    <span>{{ error }}</span>
                </div>

                <div class="form-group">
                    <label for="username">Admin Username</label>
                    <div class="input-wrap">
                        <Icon name="settings" :size="14" />
                        <input id="username" v-model="username" type="text" placeholder="e.g. admin" required />
                    </div>
                </div>

                <div class="form-group">
                    <label for="password">Password</label>
                    <div class="input-wrap">
                        <Icon name="file" :size="14" />
                        <input id="password" v-model="password" type="password" placeholder="At least 6 characters" required />
                    </div>
                </div>

                <div class="form-group">
                    <label for="confirm-password">Confirm Password</label>
                    <div class="input-wrap">
                        <Icon name="file" :size="14" />
                        <input id="confirm-password" v-model="confirmPassword" type="password" placeholder="Re-enter password" required />
                    </div>
                </div>

                <Btn type="submit" variant="primary" :disabled="loading" style="width: 100%; justify-content: center; height: 38px; margin-top: 10px;">
                    <template v-slot:default>
                        <span v-if="loading">Configuring...</span>
                        <span v-else>Initialize Admin Account</span>
                    </template>
                </Btn>
            </form>
        </div>
    </div>
</template>

<style scoped>
.setup-container {
    display: grid;
    place-items: center;
    min-height: 100vh;
    background: var(--bg-0);
    padding: 20px;
}
.setup-card {
    width: 100%;
    max-width: 420px;
    padding: 32px var(--pad-card);
    box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
    border-color: var(--hairline-strong);
    background: linear-gradient(135deg, var(--bg-1) 0%, var(--bg-0) 100%);
    backdrop-filter: blur(10px);
}
.setup-header {
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
.setup-header h3 {
    margin: 8px 0 4px;
    font-size: 18px;
    font-weight: 600;
}
.setup-header p {
    color: var(--text-2);
}
.setup-form {
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
