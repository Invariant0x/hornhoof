import { expect, test } from '@playwright/test';
import type { Decisions, ProposalDecision, Roster } from '../src/types';
import { serveApi } from './api';

test.describe.configure({ timeout: 0 });

const OPS = { id: 'd-ops', name: 'Operations' };
const role = (id: string, en: string, ru: string, required: boolean, holder: string | null) => ({
  id, title: { en, ru }, kind: 'member' as const, tier: 'standard' as const, perProduct: false, skills: [], subscription: 's-key', required, holder,
});
/* Operations with its head and watchdog there, its collector and operator missing, and two roles on top. */
const ROSTER: Roster = {
  people: [],
  roles: [
    { ...role('OPS-HEAD', 'Head of operations', 'Руководитель операционного отдела', true, 'Hanna Oleksandrivna Kovalenko'), kind: 'head' },
    role('OPS-WATCH', 'Task watchdog', 'Сторож задач', true, 'Argus'),
    role('OPS-BUGS', 'Weak point collector', 'Сборщик слабых мест', true, null),
    role('OPS-PROGRAM', 'Program operator', 'Оператор программ', true, null),
    role('OPS-FIX', 'Reliability engineer', 'Инженер надежности', false, null),
    role('OPS-INTEG', 'Integrations engineer', 'Инженер интеграций', false, null),
  ],
  products: [],
  subscriptions: [{ id: 's-key', provider: 'anthropic_api', kind: 'api_key', label: 'Team key', owner: 'Ivan', models: [] }],
};
const decisions = (name: string): Decisions => ({
  requests: [],
  proposals: [{
    id: 'pr1', kind: 'staff', brief: 'Someone to fix what breaks.', department: { ...OPS, name }, ownerPersonId: 'p1', canAnswer: true,
    items: [{ role: 'OPS-WATCH', checked: true }, { role: 'OPS-FIX', checked: true }, { role: 'OPS-INTEG', checked: false }],
  } as ProposalDecision],
  machineAccess: [],
  counts: { byPerson: { p1: 1 }, byAgent: {}, total: 1 },
});

const WORDS = {
  en: { department: 'Operations', tasks: /^Tasks/, required: 'Required role', here: 'Already here: Argus', hire: 'Hire (3)', watch: /Task watchdog/, operator: /Program operator/, extra: /Integrations engineer/, runs: 'Subscription for Program operator' },
  ru: { department: 'Операции', tasks: /^Задачи/, required: 'Обязательная роль', here: 'Уже в отделе: Argus', hire: 'Нанять (3)', watch: /Сторож задач/, operator: /Оператор программ/, extra: /Инженер интеграций/, runs: 'Подписка для Оператор программ' },
};

for (const lang of ['en', 'ru'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`the staff card of Operations in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const words = WORDS[lang];
        const errors: string[] = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname}`); });
        await serveApi(page);
        await page.route('**/api/version', route => route.fulfill({ json: { version: '0.6.1', commit: 'browser-test' } }));
        await page.route('**/api/updates', route => route.fulfill({ json: { current: { version: '0.6.1', commit: 'browser-test' }, available: false, latest: null, updater: { status: null, waiting: null } } }));
        await page.route('**/api/requests', route => route.fulfill({ json: decisions(words.department) }));
        await page.route(`**/api/departments/${OPS.id}/roster`, route => route.fulfill({ json: ROSTER }));
        let hired: { role: string }[] | undefined;
        await page.route(`**/api/departments/${OPS.id}/staff`, async route => {
          hired = (route.request().postDataJSON() as { people: { role: string }[] }).people;
          await route.fulfill({ status: 201, json: { hired: ['x'], present: [] } });
        });
        await page.addInitScript(({ lang, theme }) => {
          localStorage.setItem('hh-lang', lang);
          localStorage.setItem('hh-theme', theme);
        }, { lang, theme });
        await page.setViewportSize({ width, height: 1000 });
        await page.goto('/');
        await page.getByRole('button', { name: words.tasks }).click();
        const card = page.locator('.t-card.staff');
        await expect(card).toBeVisible();

        /* The four stay ticked and cannot be unticked; who is there shows, with nothing to pick for them. */
        const watch = card.getByRole('checkbox', { name: words.watch });
        await expect(watch).toBeChecked();
        await expect(watch).toBeDisabled();
        await watch.click({ force: true });
        await expect(watch).toBeChecked();
        const operator = card.getByRole('checkbox', { name: words.operator });
        await expect(operator).toBeChecked();
        await expect(operator).toBeDisabled();
        await expect(card.getByText(words.here)).toBeVisible();
        await expect(card.getByText(words.required, { exact: true })).toHaveCount(4);
        await expect(card.getByRole('combobox', { name: words.runs })).toBeEnabled();
        await expect(card.getByRole('checkbox', { name: words.extra })).not.toBeChecked();
        await expect(card.locator('.staff-pick')).toHaveCount(4);

        /* Nothing runs off the screen, on a phone either. */
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        const box = (await card.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        await card.screenshot({ path: info.outputPath(`staff-card-${lang}-${theme}-${width}.png`) });

        await card.getByRole('button', { name: words.hire }).click();
        await expect.poll(() => hired?.map(line => line.role).sort()).toEqual(['OPS-BUGS', 'OPS-FIX', 'OPS-HEAD', 'OPS-PROGRAM', 'OPS-WATCH']);
        expect(errors).toEqual([]);
      });
    }
  }
}
