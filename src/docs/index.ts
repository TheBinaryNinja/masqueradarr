
import gettingStartedAdmin from './getting-started-admin.md?raw';
import gettingStartedUser from './getting-started-user.md?raw';
import dashboardAdmin from './dashboard-admin.md?raw';
import dashboardUser from './dashboard-user.md?raw';
import activeStreams from './active-streams.md?raw';
import historyMetrics from './history-metrics.md?raw';
import playlists from './playlists.md?raw';
import channelsGroups from './channels-groups.md?raw';
import epgSources from './epg-sources.md?raw';
import channelMapping from './channel-mapping.md?raw';
import users from './users.md?raw';
import settings from './settings.md?raw';
import customTags from './custom-tags.md?raw';

export type DocRole = 'all' | 'admin' | 'user';

export interface DocSection {
  id: string;
  title: string;
  group: 'Getting Started' | 'Screens';
  routeNames?: string[];
  role: DocRole;
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
  { id: 'channels-groups', title: 'Channels, Groups & Failover', group: 'Screens', role: 'admin', body: channelsGroups },
  { id: 'epg-sources', title: 'EPG Sources', group: 'Screens', routeNames: ['epg-sources', 'epg-detail'], role: 'admin', body: epgSources },
  { id: 'channel-mapping', title: 'Channel Mapping', group: 'Screens', routeNames: ['mapping'], role: 'admin', body: channelMapping },
  { id: 'users', title: 'Users', group: 'Screens', routeNames: ['users'], role: 'admin', body: users },
  { id: 'settings', title: 'Settings', group: 'Screens', routeNames: ['settings'], role: 'admin', body: settings },
  { id: 'custom-tags', title: 'Custom Tags', group: 'Screens', role: 'admin', body: customTags },
];

export const DOC_GROUPS: DocSection['group'][] = ['Getting Started', 'Screens'];

export function defaultSectionFor(routeName: string | undefined, isAdmin: boolean): string {
  const visible = DOC_SECTIONS.filter((s) => sectionVisibleTo(s, isAdmin));
  if (routeName) {
    const match = visible.find((s) => s.routeNames?.includes(routeName));
    if (match) return match.id;
  }
  return visible[0]?.id ?? DOC_SECTIONS[0].id;
}

export function sectionVisibleTo(s: DocSection, isAdmin: boolean): boolean {
  if (s.role === 'all') return true;
  return isAdmin ? s.role === 'admin' : s.role === 'user';
}
