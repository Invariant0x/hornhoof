/* One current service message and its place. The update uses the startup screen.
   Once dismissed, a connection loss keeps its place in the strip. */
import { SERVICE_LINES, type Away } from '@hornhoof/protocol/service-lines';
import { connection, joined } from './connection';

export type ServiceKind = 'offline' | 'updating' | 'lost' | 'signedOut' | 'notice';

export type Notice = { id: string; line: string };

export type ServiceMessage = { id: string; kind: ServiceKind; line: string };

/* What the page shows of the road: nothing, or the one current message in the one place it stands now. loader: a page area
   shows the loader line in its own place, so the strip is not drawn on this screen. */
type ServicePlace = 'boot' | 'window' | 'strip';
export type ServiceView = { place: ServicePlace; message: ServiceMessage; loader: boolean } | null;

/* What the states are read from. */
export type Inputs = { online: boolean; away: Away | null; updating: boolean; signedOut: boolean; notices: readonly Notice[] };

/* One English line for each kind, in every language, as the protocol keeps it: the page, the window and the fallback page of
   the server's front speak the same words (#2049, #2100). */
export { SERVICE_LINES };

/* The order used by dismissible windows. An update uses the loading screen while it lasts. */
const IMPORTANCE: Record<ServiceKind, number> = { signedOut: 5, offline: 4, updating: 3, lost: 2, notice: 1 };

const said = (kind: Exclude<ServiceKind, 'notice'>): ServiceMessage => ({ id: kind, kind, line: SERVICE_LINES[kind] });

/* The states standing now, the most important first; notices in the order they came. */
export function messagesOf({ online, away, updating, signedOut, notices }: Inputs): ServiceMessage[] {
  const states: (ServiceMessage | false)[] = [
    (updating || away === 'updating') && said('updating'),
    signedOut && said('signedOut'),
    !online && said('offline'),
    away === 'lost' && said('lost'),
  ];
  const others = notices.map((n): ServiceMessage => ({ id: `notice:${n.id}`, kind: 'notice', line: n.line }));
  return [...states.filter(s => s !== false), ...others];
}

export const messageOf = (inputs: Inputs): ServiceMessage | null => messagesOf(inputs)[0] ?? null;

const sameView = (a: ServiceView, b: ServiceView): boolean =>
  a === b || (a !== null && b !== null && a.place === b.place && a.loader === b.loader && a.message.id === b.message.id && a.message.line === b.message.line);

let updating = false;
let signedOut = false;
let notices: Notice[] = [];
/* Remember the importance of the last dismissed window until all service states end. */
let closedAt = 0;
/* How many page areas show the loader line now. */
let loaders = 0;
let view: ServiceView = null;
const watchers = new Set<() => void>();

const online = (): boolean => typeof navigator === 'undefined' || navigator.onLine !== false;

function placeOf(kind: ServiceKind): ServicePlace | null {
  if (kind === 'updating') return 'boot';
  if (IMPORTANCE[kind] > closedAt) return 'window';
  return kind === 'lost' || kind === 'offline' ? 'strip' : null;
}

/* Reads every state again; the people watching hear of it only when what is drawn changed. */
function refresh(): void {
  const current = messageOf({ online: online(), away: connection.snapshot().away, updating, signedOut, notices });
  if (!current) closedAt = 0;
  const place = current && placeOf(current.kind);
  const next = current && place ? { place, message: current, loader: loaders > 0 } : null;
  if (sameView(view, next)) return;
  view = next;
  for (const watch of [...watchers]) watch();
}

connection.subscribe(refresh);
if (typeof window !== 'undefined') {
  window.addEventListener('offline', refresh);
  /* The network is back: the page looks at the server now, not after its next wait. */
  window.addEventListener('online', () => {
    connection.tryNow();
    refresh();
  });
}

export const service = {
  /* Whether the update panel is starting or watching an update. */
  setUpdate(on: boolean): void {
    updating = on;
    refresh();
  },
  /* The person's session ended, or is open again. */
  signedOut(on: boolean): void {
    signedOut = on;
    refresh();
  },
  /* Any other service notice, by an id of its own: the same id says the same notice again. */
  notify(id: string, line: string): void {
    const at = notices.findIndex(n => n.id === id);
    notices = at < 0 ? [...notices, { id, line }] : notices.map((n, i) => (i === at ? { id, line } : n));
    refresh();
  },
  clear(id: string): void {
    notices = notices.filter(n => n.id !== id);
    refresh();
  },
  /* The person dismissed the window. A connection loss stays in the strip. */
  close(): void {
    if (view?.place !== 'window') return;
    closedAt = Math.max(closedAt, IMPORTANCE[view.message.kind]);
    refresh();
  },
  /* A page area with nothing cached shows the loader line in its own place, as long as it holds this. */
  holdLoader(): () => void {
    loaders++;
    refresh();
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      loaders = Math.max(0, loaders - 1);
      refresh();
    };
  },
  subscribe: (fn: () => void): (() => void) => joined(watchers, fn),
  snapshot: (): ServiceView => view,
  /* For a test: as it was before the page said anything. */
  reset(): void {
    updating = false;
    signedOut = false;
    notices = [];
    closedAt = 0;
    loaders = 0;
    refresh();
  },
};
