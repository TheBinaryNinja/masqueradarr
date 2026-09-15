import mitt from 'mitt';
import type { Channel } from '../data';

export interface RestoreItem { kind: string; text: string }
type Events = {
  'tvapp:restore-start': { items: RestoreItem[] };
  'tvapp:restore-done': void;
  'tvapp:auth-changed': { source: string };
  'tvapp:docs-open': { section?: string };
  'tvapp:users-changed': { id?: string };
  'tvapp:failover-cascade': { source: string; children: Channel[] };
  'tvapp:channels-deleted': { source: string; ids: string[] };
  'tvapp:group-changed':
    | { source: string; kind: 'rename'; oldName: string; newName: string }
    | { source: string; kind: 'delete'; name: string };
};
export const bus = mitt<Events>();
