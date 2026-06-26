<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
</script>

<template>
  <svg
    :width="size ?? 16" :height="size ?? 16" viewBox="0 0 24 24"
    fill="none" stroke="currentColor" stroke-width="1.75"
    stroke-linecap="round" stroke-linejoin="round" class="ico"
  >
    <template v-if="name === 'dashboard'">
      <rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/>
      <rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>
    </template>
    <template v-else-if="name === 'playlist'">
      <path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>
      <circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>
    </template>
    <template v-else-if="name === 'epg'">
      <rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18"/>
      <path d="M8 4v-2"/><path d="M16 4v-2"/><path d="M8 13h3"/><path d="M14 13h4"/><path d="M8 17h6"/>
    </template>
    <template v-else-if="name === 'import'"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></template>
    <template v-else-if="name === 'map'">
      <circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/>
      <path d="M8.5 6h7a3 3 0 0 1 0 6h-7a3 3 0 0 0 0 6h-2"/>
    </template>
    <template v-else-if="name === 'settings'">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>
    </template>
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></template>
    <template v-else-if="name === 'plus'"><path d="M12 5v14"/><path d="M5 12h14"/></template>
    <template v-else-if="name === 'play'"><path d="M6 4.5v15l13-7.5z" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name === 'pause'"><rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/></template>
    <template v-else-if="name === 'refresh'">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/>
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>
    </template>
    <template v-else-if="name === 'trash'">
      <path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
      <path d="M19 6 18 20a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
      <path d="M10 11v6"/><path d="M14 11v6"/>
    </template>
    <template v-else-if="name === 'edit'">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="m18.5 2.5 3 3L12 15l-4 1 1-4z"/>
    </template>
    <template v-else-if="name === 'more'"><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></template>
    <template v-else-if="name === 'grip'">
      <circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/>
      <circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>
    </template>
    <template v-else-if="name === 'lock'"><rect x="4" y="11" width="16" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></template>
    <template v-else-if="name === 'grid'">
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </template>
    <!-- waffle: a 3×3 dot grid — the per-row "row actions" popup trigger. -->
    <template v-else-if="name === 'waffle'">
      <circle cx="6" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="6" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/>
      <circle cx="6" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="18" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="18" r="1.5" fill="currentColor" stroke="none"/>
    </template>
    <template v-else-if="name === 'list'">
      <path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/>
      <circle cx="3.5" cy="6" r="1.2"/><circle cx="3.5" cy="12" r="1.2"/><circle cx="3.5" cy="18" r="1.2"/>
    </template>
    <template v-else-if="name === 'filter'"><path d="M3 5h18"/><path d="M6 12h12"/><path d="M10 19h4"/></template>
    <template v-else-if="name === 'chevron-r'"><path d="m9 6 6 6-6 6"/></template>
    <template v-else-if="name === 'chevron-d'"><path d="m6 9 6 6 6-6"/></template>
    <template v-else-if="name === 'chevron-l'"><path d="m15 6-6 6 6 6"/></template>
    <template v-else-if="name === 'upload'"><path d="M12 15V3"/><path d="m7 8 5-5 5 5"/><path d="M5 21h14"/></template>
    <template v-else-if="name === 'link'">
      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/>
      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>
    </template>
    <template v-else-if="name === 'tv'"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M8 22h8"/><path d="M12 19v3"/></template>
    <template v-else-if="name === 'check'"><path d="M4 12.5 9 17 20 6"/></template>
    <template v-else-if="name === 'x'"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></template>
    <template v-else-if="name === 'sync'"><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/></template>
    <template v-else-if="name === 'warn'">
      <path d="M10.3 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.41 0z"/>
      <path d="M12 9v4"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>
    </template>
    <template v-else-if="name === 'add'"><circle cx="12" cy="12" r="9"/><path d="M12 8v8"/><path d="M8 12h8"/></template>
    <template v-else-if="name === 'stop'"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor" stroke="none"/></template>
    <template v-else-if="name === 'globe'">
      <circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>
      <path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>
    </template>
    <!-- orbit-globe: the masqueradarr UPLINK/radar motif (MK-07.10) — nested meridian
         ellipses + parallels, scaled into this 24×24 viewBox (r=9, factor 9/34). -->
    <template v-else-if="name === 'orbit'">
      <circle cx="12" cy="12" r="9"/>
      <ellipse cx="12" cy="12" rx="3.4" ry="9"/><ellipse cx="12" cy="12" rx="7.1" ry="9"/>
      <path d="M3 12h18"/><path d="M3.8 8h16.4"/><path d="M3.8 16h16.4"/>
    </template>
    <template v-else-if="name === 'file'">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <path d="M14 2v6h6"/>
    </template>
    <template v-else-if="name === 'logout'">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="12" height="12" rx="2"/>
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>
    </template>
    <template v-else-if="name === 'sun'">
      <circle cx="12" cy="12" r="4"/>
      <path d="M12 2v2"/><path d="M12 20v2"/>
      <path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/>
      <path d="M2 12h2"/><path d="M20 12h2"/>
      <path d="m4.93 19.07 1.41-1.41"/><path d="m17.66 6.34 1.41-1.41"/>
    </template>
    <template v-else-if="name === 'moon'"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></template>
    <template v-else-if="name === 'info'">
      <circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.6" fill="currentColor"/>
    </template>
    <template v-else-if="name === 'book'">
      <path d="M4 4.5A2 2 0 0 1 6 3h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2z"/>
      <path d="M4 17.5A2 2 0 0 1 6 16h13"/><path d="M9 7h6"/>
    </template>
    <template v-else-if="name === 'topology'">
      <circle cx="5" cy="6" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="12" r="2.2"/>
      <path d="M7.1 6.7C12 8.4 14 10 16.9 11.6"/><path d="M7.1 17.3C12 15.6 14 14 16.9 12.4"/>
    </template>
    <template v-else-if="name === 'activity'"><path d="M3 12h4l3 8 4-16 3 8h4"/></template>
    <template v-else-if="name === 'chip'">
      <rect x="6" y="6" width="12" height="12" rx="2"/>
      <rect x="9.5" y="9.5" width="5" height="5" rx="1"/>
      <path d="M9 3v3"/><path d="M15 3v3"/><path d="M9 18v3"/><path d="M15 18v3"/>
      <path d="M3 9h3"/><path d="M3 15h3"/><path d="M18 9h3"/><path d="M18 15h3"/>
    </template>
  </svg>
</template>
