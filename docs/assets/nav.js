/* ═══════════════════════════════════════════════════════════════════════════
   masqueradarr docs — the single navigation / IA config (data only).
   Consumed by masq-docs.js to build the sidebar. hrefs are RELATIVE TO THE
   docs ROOT (e.g. "index.html", "pages/concepts.html"); masq-docs.js prepends
   the "../" prefix automatically when the current page lives under /pages/.
   `soon: true` marks a page whose HTML isn't published yet — rendered as a
   muted, non-clickable item so the full information architecture stays visible.
   Keep this list in sync with the phase table in .claude/plans/pages-doc.md.
   ═══════════════════════════════════════════════════════════════════════════ */
window.MASQ_NAV = [
  {
    label: "Overview",
    links: [
      { ix: "◊", title: "Home", href: "index.html" },
      { ix: "01", title: "Concepts", href: "pages/concepts.html" },
      { ix: "02", title: "Getting started", href: "pages/getting-started.html" },
    ],
  },
  {
    label: "Core concepts",
    links: [
      { ix: "03", title: "Playlists", href: "pages/playlists.html" },
      { ix: "04", title: "Sources & adapters", href: "pages/sources.html" },
      { ix: "05", title: "EPG & guide data", href: "pages/epg.html" },
      { ix: "06", title: "Video proxy engine", href: "pages/proxy-engine.html" },
    ],
  },
  {
    label: "Operate",
    links: [
      { ix: "07", title: "Users & access", href: "pages/users.html" },
      { ix: "08", title: "Operations", href: "pages/operations.html" },
      { ix: "09", title: "Architecture", href: "pages/architecture.html" },
    ],
  },
];
