import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { AgentCardView, Me, Org } from '../src/types';
import { ME } from './api';
import { SUB } from './agent-window-api';

export type Settings = { lang: 'en' | 'ru'; theme: 'light' | 'dark'; width: number };
export type Agent = 'orchestrator' | 'b1';

/* Both agents run on the CEO's plan. Lisa is the CEO delegate, and Maria has the Development department. */
export const VIEWERS = {
  owner: { me: ME, types: true },
  delegate: { me: { ...ME, person: { ...ME.person, id: 'p2', name: 'Lisa', isOwner: false, isCeoDelegate: true }, canDecideCompany: true } satisfies Me, types: false },
  department: { me: { ...ME, person: { ...ME.person, id: 'p3', name: 'Maria', isOwner: false, scopeKind: 'listed' }, canDecideCompany: false } satisfies Me, types: false },
};
export type Viewer = keyof typeof VIEWERS;

export const ORCHESTRATOR: Org['orchestrator'] = { id: 'a1', name: 'Orchestrator', model: 'gpt-6', effort: null, subscription: SUB, context: null, program: null, alarm: null, retry: null, failure: null };
export const ORCHESTRATOR_CARD: Partial<AgentCardView> = { id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null, product: null, model: 'gpt-6', effort: null, subscription: SUB, machine: null, state: 'sleeping', currentTask: null, skills: [], parts: [], raw: '', runsOn: [], changes: [], interrupted: [], canEdit: false, timer: null };

export async function open(page: Page, agent: Agent, lang: Settings['lang']): Promise<Locator> {
  const t = lang === 'en' ? en : ru;
  await page.goto('/');
  if (agent === 'orchestrator') {
    await page.getByRole('button', { name: t.map.openOrchestrator, exact: true }).click();
    return page.getByRole('complementary', { name: t.window.title });
  }
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: lang === 'en' ? 'Members' : 'Сотрудники' }).getByRole('button', { name: /Bruno/ }).click();
  return page.getByRole('complementary', { name: /^Bruno,/ });
}

export const shot = (page: Page, info: TestInfo, name: string, { lang, theme, width }: Settings) => page.screenshot({ path: info.outputPath(`${name}-${lang}-${theme}-${width}.png`), animations: 'disabled' });

export async function checkPage(page: Page, errors: string[]) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
}

export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  return errors;
}
