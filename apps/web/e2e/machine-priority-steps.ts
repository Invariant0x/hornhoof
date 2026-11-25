import { expect, type Locator, type Page } from '@playwright/test';
import type { BuiltinView, DataView, MachineView, MoveView, Org } from '../src/types';
import { ME, box, serveApi } from './api';

const GIB = 1024 ** 3;
/* Tall enough at phone width to show the open cards without scrolling under the top bar. */
export const SIZES = [[1440, 900], [375, 2600]] as const;
export const WORDS = {
  en: {
    tab: 'Machines', open: 'Open the card of', priority: 'Priority',
    best: 'Always online, best connection to machine 1', pinned: 'Number set by hand', out: 'Never takes the server: set by hand',
    scope: "Cannot take the server: the company's data stays only on machines of people who see the whole company, and Marat sees 2 departments.",
    line: 'If machine 1 goes away, machine 2 takes the server, then 3.', outChoice: 'Does not take the server', pick: (host: string) => `Priority of ${host}`,
    onlyCopy: (host: string) => `${host} holds the only up-to-date copy; give another machine a place first.`,
    here: 'Move the server here', yes: 'Move the server', cancel: 'Cancel', stop: 'Cancel the move',
    ask: (host: string) => `Move the company server to ${host}? Hornhoof stops for a short while as it moves; your work is kept.`,
    waiting: (host: string) => `${host} takes the server once its copy is up to date (40%)`,
    led: (host: string) => new RegExp(`^${host} ran the server until .+ and is up to date again\\.$`), saving: 'Copy: saving what it did while it led',
    savingRetry: /^Copy: saving what it did while it led \(retrying after an error, since .+\)$/,
    updating: 'Hornhoof is updating. Move the server once the update ended.',
  },
  ru: {
    tab: 'Машины', open: 'Открыть карточку', priority: 'Приоритет',
    best: 'Всегда в сети, лучшая связь с машиной 1', pinned: 'Номер задан вручную', out: 'Никогда не берет сервер: так задано вручную',
    scope: 'Не может взять сервер: данные компании хранятся только на машинах тех, кто видит всю компанию, а Marat видит 2 отдела.',
    line: 'Если машина 1 пропадет, сервер возьмет машина 2, за ней 3.', outChoice: 'Не берет сервер', pick: (host: string) => `Приоритет ${host}`,
    onlyCopy: (host: string) => `${host} хранит единственную актуальную копию; сначала дайте место другой машине.`,
    here: 'Перенести сервер сюда', yes: 'Перенести сервер', cancel: 'Отмена', stop: 'Отменить перенос',
    ask: (host: string) => `Перенести сервер компании на ${host}? Пока он переезжает, Hornhoof ненадолго остановится; ваша работа сохранится.`,
    waiting: (host: string) => `${host} возьмет сервер, как только ее копия станет актуальной (40%)`,
    led: (host: string) => new RegExp(`^Машина ${host} держала сервер до .+, ее копия снова актуальна\\.$`), saving: 'Копия: сохраняет то, что сделано, пока она держала сервер',
    savingRetry: /^Копия: сохраняет то, что сделано, пока она держала сервер \(повторяет попытку после сбоя, с .+\)$/,
    updating: 'Hornhoof обновляется. Перенесите сервер, когда обновление закончится.',
  },
};

export const LONG = 'build-box-with-a-rather-long-name-of-its-own';
export const placed = (over: Partial<DataView>): DataView => ({ number: null, why: null, pin: null, unfit: null, copy: null, leftAt: null, ...over });
const machine = (id: string, hostname: string, data: DataView): MachineView => ({
  id, hostname, os: 'linux', arch: 'x86_64', owner: { id: 'p1', name: 'Ivan' }, online: true, lastSeenAt: null, plans: [],
  load: { cpus: 8, load: 1, memFree: 10 * GIB, memTotal: 16 * GIB, jobs: 0, tests: 0, cpuModel: 'AMD EPYC', diskFree: 200 * GIB, diskTotal: 500 * GIB },
  lendsTests: true, running: { agents: [], parts: [] }, data,
});
/* The server's machine, two copies of which one stands where the CEO put it, the next in line, one kept out by hand and
   one that cannot take the server. */
export const MACHINES: MachineView[] = [
  machine('m4', 'lab-nuc', placed({ number: 4, why: 'next' })),
  machine('m6', 'marat-pc', placed({ unfit: { why: 'scope', person: 'Marat', departments: 2 } })),
  machine('m2', 'dev-studio', placed({ number: 2, why: 'always.best_link', copy: { line: 'ready' } })),
  machine('m5', 'olga-air', placed({ why: 'out', pin: 'none' })),
  machine('m1', 'rack-01', placed({ number: 1, why: 'server' })),
  machine('m3', LONG, placed({ number: 3, why: 'pinned', pin: 3, copy: { line: 'making', progress: 40 } })),
];
const BUILTIN: BuiltinView = { online: true, load: null, running: { agents: [], parts: [] }, machine: { id: 'm1', hostname: 'rack-01' } };

type Sent = { path: string; body: unknown };

/* refuse: the answer to a choice or to a move; none takes it. move: what the server says of a move of the server.
   machines: the machines the tab shows. */
export async function openMachines(page: Page, language: 'en' | 'ru', theme: 'light' | 'dark', refuse?: { status: number; reason: string }, move: MoveView | null = null, machines = MACHINES): Promise<Sent[]> {
  const sent: Sent[] = [];
  await serveApi(page);
  await page.addInitScript(({ language, theme }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', theme);
  }, { language, theme });
  const org: Org = { company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [], departments: [] };
  await page.route('**/api/org', route => route.fulfill({ json: org }));
  await page.route('**/api/machines/*/move', route => {
    sent.push({ path: new URL(route.request().url()).pathname, body: route.request().method() });
    return refuse ? route.fulfill({ status: refuse.status, json: { error: { code: 'conflict', reason: refuse.reason, message: 'Refused.' } } }) : route.fulfill({ status: 202, json: { state: 'preparing' } });
  });
  await page.route('**/api/machines', route => route.fulfill({ json: { machines, builtin: BUILTIN, priority: true, move, canMove: true, copies: { leader: 'rack-01', copies: [{ hostname: 'dev-studio', sync: true }, { hostname: LONG, sync: false }], onlySince: null } } }));
  await page.route('**/api/machines/*/priority', route => {
    sent.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    return refuse ? route.fulfill({ status: refuse.status, json: { error: { code: 'conflict', reason: refuse.reason, message: 'Refused.' } } }) : route.fulfill({ status: 204 });
  });
  await page.route('**/api/subscriptions', route => route.fulfill({ json: { subscriptions: [] } }));
  await page.route('**/api/nodes/commands', route => route.fulfill({ json: { commands: [] } }));
  await page.route('**/api/machines/access', route => route.fulfill({ json: { views: [] } }));
  await page.goto('/');
  await page.getByRole('button', { name: WORDS[language].tab, exact: true }).click();
  await expect(page.getByRole('table')).toBeVisible();
  return sent;
}

export const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
/* Whether one box lies within another, to the pixel a browser may round by. */
export async function within(inner: Locator, outer: Locator): Promise<boolean> {
  const [a, b] = [await box(inner), await box(outer)];
  return a.x >= b.x - 1 && a.x + a.width <= b.x + b.width + 1;
}
