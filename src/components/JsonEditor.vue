<script setup lang="ts">
// JsonEditor.vue — a raw, syntax-highlighted multi-line JSON field with no editor dependency. A transparent
// <textarea> owns the text (caret, selection, undo, IME, spellcheck-off) and sits exactly over a <pre> that shows
// the same text as coloured tokens; the two share font, padding and line box, and scroll together. The overlay
// is rebuilt from the text on every keystroke, HTML-escaped first, so a half-typed or invalid document still
// renders exactly what is in the textarea (unrecognized characters simply stay uncoloured).
//
// Keyboard: Tab indents (two spaces). To keep the field from trapping keyboard users, Esc releases the next Tab to
// move focus as usual (announced through aria-describedby).

import { computed, ref } from 'vue';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    /** Visible height in text rows (the field is also vertically resizable). */
    rows?: number;
    /** Paint the field as invalid (e.g. the text does not parse). */
    invalid?: boolean;
    /** Accessible name of the textarea. */
    label?: string;
  }>(),
  { rows: 18, invalid: false, label: 'JSON' },
);
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>();

const ta = ref<HTMLTextAreaElement | null>(null);
const pre = ref<HTMLPreElement | null>(null);
const hintId = `json-editor-hint-${Math.random().toString(36).slice(2, 8)}`;

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One pass over the text: a string (a key when a `:` follows it), a number, a literal, or punctuation. An
// unterminated string runs to the end of its line, so typing a quote recolours only that line.
const TOKEN_RE =
  /("(?:[^"\\\n]|\\.)*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],])/g;

const highlighted = computed(() => {
  const src = props.modelValue;
  let out = '';
  let last = 0;
  for (const m of src.matchAll(TOKEN_RE)) {
    const at = m.index ?? 0;
    out += esc(src.slice(last, at));
    if (m[1] !== undefined) {
      out += `<span class="${m[2] ? 'j-key' : 'j-str'}">${esc(m[1])}</span>`;
      if (m[2]) out += `<span class="j-punc">${esc(m[2])}</span>`;
    } else if (m[3] !== undefined) {
      out += `<span class="j-num">${m[3]}</span>`;
    } else if (m[4] !== undefined) {
      out += `<span class="j-lit">${m[4]}</span>`;
    } else {
      out += `<span class="j-punc">${esc(m[5])}</span>`;
    }
    last = at + m[0].length;
  }
  // A <pre> drops a trailing newline; pad one so the overlay keeps the textarea's last (empty) line.
  return `${out}${esc(src.slice(last))}\n`;
});

function syncScroll(): void {
  if (!ta.value || !pre.value) return;
  pre.value.scrollTop = ta.value.scrollTop;
  pre.value.scrollLeft = ta.value.scrollLeft;
}

let tabReleased = false;
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    tabReleased = true;
    return;
  }
  if (e.key !== 'Tab' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
    tabReleased = false;
    return;
  }
  if (tabReleased) {
    tabReleased = false;
    return; // let Tab move focus
  }
  e.preventDefault();
  const el = ta.value;
  if (!el) return;
  // insertText keeps the browser's undo stack intact; fall back to a manual splice where it is unsupported.
  if (!document.execCommand('insertText', false, '  ')) {
    const { selectionStart: a, selectionEnd: b, value } = el;
    emit('update:modelValue', `${value.slice(0, a)}  ${value.slice(b)}`);
    requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
  }
}
</script>

<template>
  <div class="json-editor" :class="{ invalid }">
    <pre ref="pre" class="json-layer json-hl" aria-hidden="true" v-html="highlighted" />
    <textarea
      ref="ta"
      class="json-layer json-input"
      :value="modelValue"
      :rows="rows"
      :aria-label="label"
      :aria-invalid="invalid || undefined"
      :aria-describedby="hintId"
      wrap="off"
      spellcheck="false"
      autocapitalize="off"
      autocomplete="off"
      autocorrect="off"
      @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
      @scroll="syncScroll"
      @keydown="onKeydown"
    />
    <span :id="hintId" class="sr-only">Tab indents. Press Escape, then Tab, to leave the editor.</span>
  </div>
</template>

<style scoped>
.json-editor {
  position: relative;
  border: 1px solid var(--hairline);
  border-radius: var(--radius-s);
  background: var(--bg-1);
  transition: border-color .12s, box-shadow .12s;
}
.json-editor:focus-within {
  border-color: oklch(0.82 0.13 220 / 0.5);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.json-editor.invalid { border-color: var(--bad); }

/* Both layers must share every metric that affects where a glyph lands. */
.json-layer {
  display: block;
  box-sizing: border-box;
  width: 100%;
  margin: 0;
  padding: 10px 12px;
  border: 0;
  font-family: var(--mq-font-mono);
  font-size: 12px;
  line-height: 1.6;
  letter-spacing: normal;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
}
.json-hl {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  color: var(--text-1);
}
.json-input {
  position: relative;
  min-height: 120px;
  overflow: auto;
  resize: vertical;
  background: transparent;
  color: transparent;
  -webkit-text-fill-color: transparent;
  caret-color: var(--text-0);
  outline: none;
}
.json-input::selection { background: var(--accent-glow); }

.json-hl :deep(.j-key) { color: var(--accent); }
.json-hl :deep(.j-str) { color: var(--good); }
.json-hl :deep(.j-num) { color: var(--warn); }
/* true/false/null: a violet derived from two theme tokens, so it re-tunes with the light/dark theme like the rest. */
.json-hl :deep(.j-lit) { color: color-mix(in oklch, var(--accent), var(--bad)); }
.json-hl :deep(.j-punc) { color: var(--text-2); }

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
