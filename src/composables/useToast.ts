// Global toast store — a module-level singleton (like useSettings/useTweaks). Any screen can raise a
// toast via useToast() (or the standalone pushToast); three positioned host components render the shared
// queue: ToastBanner (top-middle), ToastUpperRight, ToastLowerRight. Each toast auto-dismisses after
// `duration` ms with a decrementing progress bar (the bar's CSS animation-duration is the same `duration`),
// can be dismissed manually, and pauses on hover (the host card wires mouseenter/leave to pause/resume,
// which freeze BOTH the JS dismissal timer and the CSS bar so they stay in lockstep).

import { ref, type Ref } from 'vue';

export type ToastPosition = 'banner' | 'lower-right' | 'upper-right';
export type ToastTone = 'info' | 'good' | 'warn' | 'bad';

export interface ToastInput {
  text: string;
  title?: string;
  tone?: ToastTone;          // default 'info'
  position?: ToastPosition;  // default 'lower-right'
  icon?: string;             // Icon name override; default derived from tone
  duration?: number;         // ms; default 5000; <= 0 => sticky (no timer, no progress bar)
}

export interface ToastItem {
  id: number;
  position: ToastPosition;
  tone: ToastTone;
  title?: string;
  text: string;
  icon: string;
  duration: number;
  paused: boolean;
}

const DEFAULT_DURATION = 5000;

// Default icon per tone (all exist in Icon.vue — 'info' is added alongside this store).
const TONE_ICON: Record<ToastTone, string> = {
  info: 'info',
  good: 'check',
  warn: 'warn',
  bad: 'warn',
};

// The shared queue every host component renders (filtered by position).
export const TOASTS: Ref<ToastItem[]> = ref([]);

let nextId = 1;
// Per-toast dismissal bookkeeping so a hover can pause/resume with the correct remaining time.
const timers = new Map<number, { timeoutId: number; startedAt: number; remaining: number }>();

function arm(id: number, ms: number): void {
  const timeoutId = window.setTimeout(() => dismissToast(id), ms);
  timers.set(id, { timeoutId, startedAt: Date.now(), remaining: ms });
}

export function pushToast(input: ToastInput): number {
  const id = nextId++;
  const tone = input.tone ?? 'info';
  const duration = input.duration ?? DEFAULT_DURATION;
  const item: ToastItem = {
    id,
    position: input.position ?? 'lower-right',
    tone,
    title: input.title,
    text: input.text,
    icon: input.icon ?? TONE_ICON[tone],
    duration,
    paused: false,
  };
  TOASTS.value = [...TOASTS.value, item];
  if (duration > 0) arm(id, duration);
  return id;
}

export function dismissToast(id: number): void {
  TOASTS.value = TOASTS.value.filter((t) => t.id !== id);
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer.timeoutId);
    timers.delete(id);
  }
}

export function pauseToast(id: number): void {
  const timer = timers.get(id);
  if (!timer) return; // sticky toast or already firing
  clearTimeout(timer.timeoutId);
  timer.remaining = Math.max(0, timer.remaining - (Date.now() - timer.startedAt));
  const item = TOASTS.value.find((t) => t.id === id);
  if (item) item.paused = true;
}

export function resumeToast(id: number): void {
  const timer = timers.get(id);
  if (!timer) return;
  const item = TOASTS.value.find((t) => t.id === id);
  if (item) item.paused = false;
  arm(id, timer.remaining);
}

export function useToast() {
  return {
    toasts: TOASTS,
    push: pushToast,
    dismiss: dismissToast,
    pause: pauseToast,
    resume: resumeToast,
    banner: (input: Omit<ToastInput, 'position'>) => pushToast({ ...input, position: 'banner' }),
    lowerRight: (input: Omit<ToastInput, 'position'>) => pushToast({ ...input, position: 'lower-right' }),
    upperRight: (input: Omit<ToastInput, 'position'>) => pushToast({ ...input, position: 'upper-right' }),
  };
}
