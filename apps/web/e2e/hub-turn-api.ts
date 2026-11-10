import type { Page } from '@playwright/test';
import type { Org, TurnView } from '../src/types';
import { ME, serveApi } from './api';

export const HUB_TURN: TurnView = {
  id: 'u3', number: 3, title: 'Payment rollout', goal: 'Ship payments', status: 'open', mode: 'echelons', messages: [], taskId: null,
  startedAt: '2026-11-04T10:00:00.000Z', openedAt: '2026-11-04T10:00:00.000Z', closedAt: null,
  tasks: { done: 3, total: 17 },
};

const ORG: Org = {
  company: ME.company,
  orchestrator: { id: 'a1', name: 'Orchestrator', model: '', effort: null, subscription: null, context: null, program: null, alarm: null, retry: null, failure: null },
  agents: { total: 3, working: 1 }, people: [],
  departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', agents: { total: 3, working: 1 }, products: [], teams: [], people: [], employees: [], roles: [] }],
};

declare global {
  interface Window { hubTaskEvent: (type: 'task' | 'org') => void }
}

/* The server stream is external to the page; the real stream listeners and refetch paths still run. */
export async function taskStream(page: Page) {
  await page.addInitScript(() => {
    const sources: (EventTarget & { readyState: number })[] = [];
    class Source extends EventTarget {
      static readonly CLOSED = 2;
      readyState = 1;
      constructor(readonly url: string) {
        super();
        sources.push(this);
        queueMicrotask(() => this.dispatchEvent(new Event('open')));
      }
      close() { this.readyState = 2; }
    }
    Object.defineProperty(window, 'EventSource', { value: Source });
    window.hubTaskEvent = type => sources.filter(s => s.readyState !== Source.CLOSED).forEach(s => s.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type }) })));
  });
}

export async function serveHubTurn(page: Page) {
  let current: TurnView | null = { ...HUB_TURN };
  await taskStream(page);
  await serveApi(page);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/org') return route.fulfill({ json: { ...ORG, turn: current && { id: current.id, number: current.number, goal: current.goal } } });
    if (url.pathname === '/api/turns') return route.fulfill({ json: { turns: current ? [current] : [] } });
    if (url.pathname === '/api/version') return route.fulfill({ json: { version: '0.6.1', commit: 'turn-progress' } });
    if (url.pathname === '/api/updates') return route.fulfill({ json: { current: { version: '0.6.1', commit: 'turn-progress' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    return route.fallback();
  });
  return {
    updateTasks: async (tasks: TurnView['tasks']) => {
      current = { ...current!, tasks };
      await page.evaluate(() => window.hubTaskEvent('task'));
    },
    closeTurn: async () => {
      current = null;
      await page.evaluate(() => window.hubTaskEvent('org'));
    },
  };
}
