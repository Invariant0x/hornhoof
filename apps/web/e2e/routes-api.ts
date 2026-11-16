import { emptyEchelonFindings } from '@hornhoof/protocol/echelons';
import type { Page } from '@playwright/test';
import type { MachineView, Org, PersonView, TaskDetail, UpdatesView } from '../src/types';
import { ME, serveApi, TASKS } from './api';

const ACCESS = { whole: true, departments: [], teams: [] };
const PEOPLE: PersonView[] = [
  { id: 'p1', name: 'Ivan', email: 'ivan@acme.test', title: 'CEO', status: 'active', isOwner: true, access: ACCESS },
  { id: 'p2', name: 'Maria', email: 'maria@acme.test', title: 'Deputy', status: 'active', isOwner: false, access: ACCESS },
];
const ORG: Org = {
  company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: PEOPLE,
  departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }],
};
const MACHINE: MachineView = {
  id: 'm1', hostname: 'build-box', owner: { id: 'p1', name: 'Ivan' }, os: 'linux', arch: 'x86_64', online: false,
  lastSeenAt: null, load: null, plans: [], lendsTests: true, running: { agents: [], parts: [] },
};
const VERSION = { version: '0.6.1', commit: 'routes-fixture', migrations: 57 };
const UPDATES: UpdatesView = { current: VERSION, available: false, latest: null, versions: [], checkedAt: null, error: null, updater: { present: false, status: null, waiting: null, calledOff: null } };

export async function serveRoutes(page: Page, options: { signedOut?: boolean; person?: 'p1' | 'p2' } = {}) {
  let signedIn = !options.signedOut;
  const person = PEOPLE.find(p => p.id === (options.person ?? 'p1'))!;
  const me = { ...ME, person: { ...ME.person, id: person.id, name: person.name, email: person.email, isOwner: person.isOwner } };
  const detail: TaskDetail = { ...TASKS[0]!, echelonFindings: emptyEchelonFindings(), body: 'The shared checkout task.', parent: null, after: [], executor: TASKS[0]!.assignee, createdBy: null, subtasks: [], log: [], requests: [] };
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/auth/login') { signedIn = true; return route.fulfill({ json: { person: me.person } }); }
    if (path === '/api/me') return route.fulfill(signedIn ? { json: me } : { status: 401, json: { error: { code: 'unauthorized' } } });
    if (path === '/api/tasks/foreign') return route.fulfill({ status: 403, json: { error: { code: 'forbidden' } } });
    const replies: Record<string, unknown> = {
      '/api/org': ORG, '/api/people': { people: PEOPLE }, '/api/machines': { machines: [MACHINE] },
      '/api/subscriptions': { subscriptions: [] }, '/api/nodes/commands': { commands: [] },
      '/api/version': VERSION, '/api/updates/current': VERSION, '/api/updates': UPDATES,
      '/api/link': { link: null, domain: 'example.test' },
      '/api/tasks/t1': { task: detail },
      '/api/machines/m1/connection-history': { events: [], summary: null },
    };
    if (path in replies) return route.fulfill({ json: replies[path] });
    /* A department card lists none of its open tasks; the Tasks screen reads all of them from the shared fixture. */
    if (path === '/api/tasks' && url.searchParams.get('status') !== 'all') return route.fulfill({ json: { tasks: [] } });
    return route.fallback();
  });
}
