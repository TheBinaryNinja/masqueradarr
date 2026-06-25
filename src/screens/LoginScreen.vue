<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { login } from '../composables/useAuth';
import Icon from '../components/Icon.vue';
import Btn from '../components/Btn.vue';
import MasqMark from '../components/MasqMark.vue';

const router = useRouter();
const appVersion = import.meta.env.VITE_APP_VERSION || 'dev';
const username = ref('');
const password = ref('');
const error = ref('');
const loading = ref(false);

// Deterministic Code128-style barcode strip — same seed, same bars (the brand
// card's barcode generator, masqueradarr-card "The deterministic barcode").
// Offline / self-contained: the login screen never calls out for artwork.
const barcode = (() => {
    const rects: { x: number; w: number }[] = [];
    let seed = 20240624, x = 0, ink = true;
    while (x < 408) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const w = 2 + (seed % 5);
        if (ink) rects.push({ x, w });
        x += w;
        ink = !ink;
    }
    return { rects, width: x };
})();

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
    <div class="auth-stage">
        <!-- decorative UPLINK micrographic plate behind the card (masqueradarr-micrographics MK-07.2) -->
        <svg class="auth-plate" viewBox="0 0 360 230" aria-hidden="true">
            <g stroke="var(--bracket)" stroke-width="1.5" fill="none">
                <path d="M14 28 V14 H28" /><path d="M346 28 V14 H332" />
                <path d="M14 202 V216 H28" /><path d="M346 202 V216 H332" />
            </g>
            <ellipse cx="180" cy="128" rx="96" ry="40" transform="rotate(-18 180 128)"
                     fill="none" stroke="var(--mq-teal)" stroke-width="2"
                     stroke-dasharray="1 8" stroke-linecap="round" opacity="0.7" />
            <ellipse cx="180" cy="128" rx="96" ry="40" transform="rotate(-18 180 128)"
                     fill="none" stroke="var(--mq-steel)" stroke-width="1" />
            <g stroke="var(--mq-teal)" stroke-width="1" opacity="0.55">
                <line x1="180" y1="128" x2="92" y2="106" />
                <line x1="180" y1="128" x2="270" y2="150" />
                <line x1="180" y1="128" x2="206" y2="68" />
            </g>
            <g fill="var(--mq-teal)">
                <circle cx="92" cy="106" r="4" /><circle cx="270" cy="150" r="4" /><circle cx="206" cy="68" r="3" />
            </g>
            <g transform="translate(155,103) scale(0.41667)">
                <path d="M26 94 L26 30 L60 64 L94 30 L94 94" fill="none" stroke="var(--mq-teal)"
                      stroke-width="14" stroke-linejoin="round" stroke-linecap="round" />
            </g>
        </svg>

        <div class="auth-card card">
            <!-- corner brackets -->
            <span class="corner tl" /><span class="corner tr" />
            <span class="corner bl" /><span class="corner br" />

            <!-- top micro row -->
            <div class="micro-row">
                <span class="micro-hi">MASQUERADARR // ACCESS</span>
                <span>MK-SYS / SECURE</span>
            </div>

            <div class="auth-header">
                <div class="overline">
                    <span class="ov-tag">SYS</span>
                    <span class="ov-rule" />
                    <span class="ov-dim">SELF-HOSTED MEDIA</span>
                </div>
                <div class="lockup">
                    <MasqMark class="lockup-mark" :size="40" />
                    <span class="lockup-word">masqueradarr</span>
                </div>
                <p class="muted auth-tagline">Sign in to manage your IPTV feeds and channels.</p>
            </div>

            <!-- ticked divider -->
            <div class="divider">
                <span class="div-fill" />
                <span class="tick" style="left:0" /><span class="tick" style="left:25%" />
                <span class="tick" style="left:50%" /><span class="tick" style="left:75%" />
            </div>

            <form @submit.prevent="handleLogin" class="auth-form">
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

            <!-- foot: deterministic barcode + spec strip -->
            <div class="auth-foot">
                <svg class="barcode" :viewBox="`0 0 ${barcode.width} 30`" preserveAspectRatio="none" aria-hidden="true">
                    <rect v-for="(r, i) in barcode.rects" :key="i" :x="r.x" y="0" :width="r.w" height="30" />
                </svg>
                <div class="spec-strip">
                    <span><span class="sp-key">STREAM</span> TV</span>
                    <span><span class="sp-key">LINK</span> SECURE</span>
                    <span><span class="sp-key">VER</span> {{ appVersion }}</span>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Full-bleed masqueradarr brand stage — the same teal-aurora + vignette field
   shared with the Dashboard (.mq-stage in styles.css). The gradient runs
   edge-to-edge: no padding on the stage itself; the 20px inset lives on the
   centered card wrapper (.auth-stage > * below) so the field never insets. */
.auth-stage {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 100vh;
    background:
        radial-gradient(120% 80% at 50% -12%, var(--accent-soft), transparent 58%),
        radial-gradient(90% 70% at 100% 112%, var(--mq-teal-veil), transparent 60%),
        var(--bg-0);
    overflow: hidden;
}
/* edge vignette — deepens the periphery so the lit card reads as elevated */
.auth-stage::before {
    content: '';
    position: absolute;
    inset: 0;
    pointer-events: none;
    z-index: 0;
    background: radial-gradient(125% 105% at 50% 36%, transparent 56%, rgb(0 0 0 / 0.28) 100%);
}
/* the centered card carries the inset; the gradient stays full-bleed */
.auth-stage > .auth-card { margin: 20px; }
.auth-plate {
    position: absolute;
    width: 540px;
    max-width: 80vw;
    opacity: 0.16;
    filter: blur(0.2px);
    pointer-events: none;
    z-index: 0;
}
.auth-card {
    position: relative;
    z-index: 1;
    width: 100%;
    max-width: 400px;
    padding: 30px var(--pad-card) 22px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.4);
    border-color: var(--hairline-strong);
    background: linear-gradient(135deg, var(--bg-1) 0%, var(--bg-0) 100%);
    backdrop-filter: blur(10px);
}

/* corner brackets */
.corner {
    position: absolute;
    width: 14px;
    height: 14px;
    pointer-events: none;
}
.corner.tl { top: 9px; left: 9px; border-top: 1.5px solid var(--accent); border-left: 1.5px solid var(--accent); }
.corner.tr { top: 9px; right: 9px; border-top: 1.5px solid var(--accent); border-right: 1.5px solid var(--accent); }
.corner.bl { bottom: 9px; left: 9px; border-bottom: 1.5px solid var(--accent); border-left: 1.5px solid var(--accent); }
.corner.br { bottom: 9px; right: 9px; border-bottom: 1.5px solid var(--accent); border-right: 1.5px solid var(--accent); }

.micro-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-family: var(--mq-font-mono);
    font-size: 9.5px;
    letter-spacing: 0.16em;
    color: var(--text-3);
    margin-bottom: 18px;
}
.micro-hi { color: var(--text-2); }

.auth-header { margin-bottom: 16px; }
.overline {
    display: flex;
    align-items: center;
    gap: 9px;
    margin-bottom: 12px;
}
.ov-tag {
    font-family: var(--mq-font-mono);
    font-size: 10.5px;
    letter-spacing: 0.16em;
    color: var(--accent);
}
.ov-rule { height: 1px; width: 42px; background: var(--accent); opacity: 0.5; }
.ov-dim {
    font-family: var(--mq-font-mono);
    font-size: 10.5px;
    letter-spacing: 0.16em;
    color: var(--text-3);
}
.lockup {
    display: flex;
    align-items: center;
    gap: 11px;
}
.lockup-mark { color: var(--accent); flex: none; filter: drop-shadow(0 0 16px var(--accent-glow)); }
.lockup-word {
    font-family: var(--mq-font-sans);
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.035em;
    line-height: 1;
    color: var(--text-0);
}
.auth-tagline {
    color: var(--text-2);
    font-size: var(--fs-sm);
    margin: 12px 0 0;
}

.divider {
    position: relative;
    height: 1px;
    background: var(--hairline);
    margin: 0 0 20px;
}
.div-fill { position: absolute; left: 0; top: 0; height: 2px; width: 38%; background: var(--accent); }
.tick { position: absolute; top: -3px; width: 1px; height: 7px; background: var(--hairline-strong); }

.auth-form {
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
    font-family: var(--mq-font-mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
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
    border-color: var(--accent);
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
    background: oklch(0.65 0.17 28 / 0.12);
    border: 1px solid oklch(0.65 0.17 28 / 0.3);
    border-radius: var(--radius-s);
    color: var(--bad);
    font-size: var(--fs-sm);
}

.auth-foot { margin-top: 22px; }
.barcode {
    display: block;
    width: 100%;
    height: 26px;
    opacity: 0.8;
}
.barcode rect { fill: var(--text-1); }
.spec-strip {
    display: flex;
    gap: 22px;
    margin-top: 12px;
    font-family: var(--mq-font-mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--text-1);
}
.spec-strip .sp-key { color: var(--text-3); margin-right: 5px; }
</style>
