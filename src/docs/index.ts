// The end-user documentation section index — drives the Docs slide-out panel (DocsDrawer.vue).
//
// Each section's prose lives in a sibling `<id>.md` file, imported raw (Vite-native `?raw`) and rendered
// with `marked` at runtime. To add or change a section: add the `.md`, import it, and push a DocSection
// here (order in this array = order in the panel + TOC). Keep this index and the per-screen markdown in
// sync with the live screens — see .claude/skills/user-guide/SKILL.md (the maintenance/drift index).

import gettingStartedAdmin from './getting-started-admin.md?raw';
import gettingStartedUser from './getting-started-user.md?raw';
import dashboardAdmin from './dashboard-admin.md?raw';
import dashboardUser from './dashboard-user.md?raw';
import activeStreams from './active-streams.md?raw';
import historyMetrics from './history-metrics.md?raw';
import playlists from './playlists.md?raw';
import epgSources from './epg-sources.md?raw';
import channelMapping from './channel-mapping.md?raw';
import users from './users.md?raw';
import settings from './settings.md?raw';

// Who a section is for. 'all' shows to everyone; 'admin'/'user' gate by role so the TOC mirrors the
// SPA's own role gating (standard users only reach the Dashboard).
export type DocRole = 'all' | 'admin' | 'user';

export interface DocSection {
  /** Anchor id + default-section key (matches a route name where applicable). */
  id: string;
  /** TOC label. */
  title: string;
  /** TOC group heading. */
  group: 'Getting Started' | 'Screens';
  /** route.name(s) this section documents — used to default the panel to the current screen. */
  routeNames?: string[];
  /** Audience gate for the TOC. */
  role: DocRole;
  /** Raw markdown body. */
  body: string;
}

export const DOC_SECTIONS: DocSection[] = [
  { id: 'getting-started-admin', title: 'Day-one Setup (Admin)', group: 'Getting Started', role: 'admin', body: gettingStartedAdmin },
  { id: 'getting-started-user', title: 'Getting Started', group: 'Getting Started', role: 'user', body: gettingStartedUser },
  { id: 'dashboard-admin', title: 'Dashboard (Admin)', group: 'Screens', routeNames: ['dashboard'], role: 'admin', body: dashboardAdmin },
  { id: 'dashboard-user', title: 'Dashboard (Your Channels)', group: 'Screens', routeNames: ['dashboard'], role: 'user', body: dashboardUser },
  { id: 'active-streams', title: 'Active Streams', group: 'Screens', routeNames: ['active'], role: 'admin', body: activeStreams },
  { id: 'history-metrics', title: 'History / Metrics', group: 'Screens', routeNames: ['history'], role: 'admin', body: historyMetrics },
  { id: 'playlists', title: 'Playlists', group: 'Screens', routeNames: ['playlists', 'playlist'], role: 'admin', body: playlists },
  { id: 'epg-sources', title: 'EPG Sources', group: 'Screens', routeNames: ['epg-sources', 'epg-detail'], role: 'admin', body: epgSources },
  { id: 'channel-mapping', title: 'Channel Mapping', group: 'Screens', routeNames: ['mapping'], role: 'admin', body: channelMapping },
  { id: 'users', title: 'Users', group: 'Screens', routeNames: ['users'], role: 'admin', body: users },
  { id: 'settings', title: 'Settings', group: 'Screens', routeNames: ['settings'], role: 'admin', body: settings },
];

/** TOC groups in display order. */
export const DOC_GROUPS: DocSection['group'][] = ['Getting Started', 'Screens'];

/**
 * Pick the section to open to for a given route + role. Admins land on the admin variant of a screen,
 * standard users on the user variant; child routes (e.g. 'playlist') resolve to their parent section.
 * Falls back to the first section the role can see.
 */
export function defaultSectionFor(routeName: string | undefined, isAdmin: boolean): string {
  const visible = DOC_SECTIONS.filter((s) => sectionVisibleTo(s, isAdmin));
  if (routeName) {
    const match = visible.find((s) => s.routeNames?.includes(routeName));
    if (match) return match.id;
  }
  return visible[0]?.id ?? DOC_SECTIONS[0].id;
}

/** Whether a section shows in the TOC for the current role. */
export function sectionVisibleTo(s: DocSection, isAdmin: boolean): boolean {
  if (s.role === 'all') return true;
  return isAdmin ? s.role === 'admin' : s.role === 'user';
}
