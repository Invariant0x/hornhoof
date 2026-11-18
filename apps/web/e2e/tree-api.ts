import type { Page } from '@playwright/test';
import { serveApi } from './api';
import type { AgentCardView, Employee } from '../src/types';
import { wholeTurn } from './whole-turn';

export async function serveTree(page: Page, live: { during: boolean }) {
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url()), path = url.pathname + url.search;
    const { tree, org } = wholeTurn(live.during);
    const routes: Record<string, unknown> = {
      '/api/org': org,
      '/api/departments/d2/tree': { tree },
      '/api/departments/d2/approval-policy': { departmentId: 'd2', owner: null, canSetOwner: true, canChangePolicy: true, candidates: [], rules: [{ channel: 'message', mode: 'every' }, { channel: 'price', mode: 'every' }, { channel: 'publication', mode: 'every' }, { channel: 'commit', mode: 'every' }, { channel: 'spend', mode: 'every' }, { channel: 'other', mode: 'every' }] },
      '/api/tasks?status=open&department=d2': { tasks: [] },
      '/api/version': { version: '0.5.0', commit: 'task-148' },
      '/api/updates': { current: { version: '0.5.0', commit: 'task-148' }, available: false, latest: null, updater: { status: null, waiting: null } },
    };
    const employee = org.departments[0]!.employees.find(e => path.startsWith(`/api/agents/${e.id}/`) || path === `/api/agents/${e.id}`);
    if (employee) {
      if (path.endsWith('/events?last=300')) return route.fulfill({ json: { events: [], state: { ready: true, reason: null, busy: employee.state === 'working', runningJobId: null, queued: 0, terminal: false } } });
      if (path === `/api/agents/${employee.id}`) return route.fulfill({ json: agentCard(employee) });
      if (path.endsWith('/messages')) return route.fulfill({ json: { queued: true } });
    }
    return path in routes ? route.fulfill({ json: routes[path] }) : route.fallback();
  });
}


function agentCard(employee: Employee): AgentCardView {
  return { currentTask: employee.task ? { id: employee.task.id, number: employee.task.number, title: employee.task.title } : null, id: employee.id, name: employee.name, kind: employee.kind, role: null, department: { id: 'd2', name: 'Development' },
    product: null, model: '', effort: null, subscription: null, machine: null, state: employee.state, retry: null, failure: null, skills: [], parts: [],
    raw: '', runsOn: [], changes: [], interrupted: [], canEdit: false, canRemove: false, timer: null };
}
