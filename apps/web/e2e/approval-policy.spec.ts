/// <reference types="node" />
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en, type Messages } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { LANGUAGES, type Language } from '../src/i18n';
import type { ApprovalPolicyView, AutonomousReleaseEntry, Org } from '../src/types';
import { ME, serveApi } from './api';
import { around, focusRing, offences, sizes } from './owner-screens-look';
import type { Measured } from './owner-screens-sizes';

const MESSAGES: Record<Language, Messages> = { en, ru };

/* Rank the actual approval words of every shipped language for the narrow and wide checks. */
const LOCALE_LENGTHS = LANGUAGES.map(({ id }) => {
  const a = MESSAGES[id].dept.approvals;
  const strings = [a.title, a.owner, a.ownerCeo, a.ownerNone, a.ownerIs('Dana'), a.ownerHint, a.noCandidates, a.defaultHint, a.rulesHint, a.mode, ...Object.values(a.modes), ...Object.values(a.readModes), ...Object.values(a.channels), a.limit, a.unit, a.unitPlaceholder, a.limitIs(100, 'USD'), a.autonomousRelease, a.autonomousReleaseHint, a.autonomousReleaseWord(false)];
  return { id, length: strings.reduce((sum, value) => sum + value.length, 0) };
}).sort((a, b) => a.length - b.length);
const CHECKED_LOCALES = [...new Set([LOCALE_LENGTHS[0]!.id, LOCALE_LENGTHS.at(-1)!.id, ...LANGUAGES.map(l => l.id).filter(id => /^(ar|fa|he|ur)(-|$)/.test(id))])];
const ORG: Org = {
  company: ME.company,
  orchestrator: null,
  agents: { total: 0, working: 0 },
  people: [],
  departments: [{ id: 'd2', name: 'Development', templateKey: null, roleCode: 'CTO', about: '', ownerPersonId: null, agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [] }],
};
const JOURNAL: AutonomousReleaseEntry[] = [
  {
    id: 'ar1',
    departmentId: 'd2',
    taskId: 't12',
    taskNumber: 12,
    agentId: 'a1',
    agentName: 'Hana',
    commitSha: 'd7a1eb2b34edb970a2c5abbaadf25e50d4dc4031',
    baseCommitSha: '1111111111111111111111111111111111111111',
    testRunId: 'tr43',
    testRunNumber: 43,
    ciState: null,
    ciChecks: null,
    reviewerAgentId: 'a2',
    reviewerName: 'Rita',
    verdictStage: 'review',
    createdAt: '2026-11-14T12:00:00.000Z',
  },
];
const POLICY: ApprovalPolicyView = {
  departmentId: 'd2',
  owner: null,
  canSetOwner: true,
  canChangePolicy: true,
  autonomousRelease: false,
  canSetAutonomousRelease: true,
  hasAutonomousReleases: false,
  candidates: [{ id: 'p2', name: 'Dana Abramovna Konstantinopolskaya', title: 'Head of Very Long Titles' }, { id: 'p3', name: 'Wes', title: '' }],
  rules: [
    { channel: 'message', mode: 'new_kinds' },
    { channel: 'price', mode: 'every' },
    { channel: 'publication', mode: 'every' },
    { channel: 'commit', mode: 'every' },
    { channel: 'spend', mode: 'within_limits', limit: 100, unit: 'USD' },
    { channel: 'other', mode: 'every' },
  ],
};

/* The department's panel as a person meets it, with what the page logs. Every change is answered as the server would.
   A theme is a skin's id; dark, a name no skin has, is Cyberpunk. Right to left as a shipped RTL language would set it. */
async function open(page: Page, lang: Language, theme: string, width: number, policy = POLICY, dir: 'ltr' | 'rtl' = 'ltr') {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, theme, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { lang, theme, dir });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await serveApi(page);
  let shown = policy;
  const puts: { url: string; body: unknown }[] = [];
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/org') return route.fulfill({ json: ORG });
    if (url.pathname === '/api/version') return route.fulfill({ json: { version: '0.7.0', commit: 'task-355' } });
    if (url.pathname === '/api/updates') return route.fulfill({ json: { current: { version: '0.7.0', commit: 'task-355' }, available: false, latest: null, updater: { status: null, waiting: null } } });
    if (url.pathname === '/api/departments/d2/approval-policy') return route.fulfill({ json: shown });
    if (url.pathname === '/api/autonomous-releases') return route.fulfill({ json: { entries: JOURNAL } });
    if (url.pathname === '/api/departments/d2/approval-policy/autonomous-release') {
      const body = route.request().postDataJSON() as { enabled: boolean };
      puts.push({ url: url.pathname, body });
      shown = { ...shown, autonomousRelease: body.enabled, hasAutonomousReleases: true };
      return route.fulfill({ json: shown });
    }
    if (url.pathname === '/api/departments/d2/owner') {
      const body = route.request().postDataJSON() as { personId: string | null };
      puts.push({ url: url.pathname, body });
      if (body.personId === 'p3') return route.fulfill({ status: 400, json: { error: { code: 'validation', message: en.errors.owner_no_access, reason: 'owner_no_access' } } });
      const named = shown.candidates.find(c => c.id === body.personId);
      shown = { ...shown, owner: named ? { id: named.id, name: named.name } : null };
      return route.fulfill({ json: { ownerPersonId: body.personId } });
    }
    if (url.pathname.startsWith('/api/departments/d2/approval-policy/')) {
      const channel = url.pathname.split('/').pop() as ApprovalPolicyView['rules'][number]['channel'];
      const body = route.request().postDataJSON() as object;
      puts.push({ url: url.pathname, body });
      shown = { ...shown, rules: shown.rules.map(r => (r.channel === channel ? ({ channel, ...body } as ApprovalPolicyView['rules'][number]) : r)) };
      return route.fulfill({ json: shown });
    }
    return route.fallback();
  });
  await page.goto('/departments/d2');
  await page.getByRole('button', { name: MESSAGES[lang].dept.about, exact: true }).click();
  await expect(page.getByRole('heading', { name: MESSAGES[lang].dept.approvals.title, exact: true })).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  /* Tall enough that the panel shows the whole section, without scrolling, in its screenshots. */
  await page.setViewportSize({ width, height: 2000 });
  return { errors, puts };
}

const section = (page: Page, t: Messages) => page.getByRole('region', { name: t.dept.approvals.title, exact: true }).or(page.locator('section', { has: page.getByRole('heading', { name: t.dept.approvals.title, exact: true }) })).first();

async function fitsTheScreen(page: Page, width: number) {
  const scroll = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, drawer: document.querySelector('.dv-drawer')?.scrollWidth ?? 0, inner: document.querySelector('.dv-drawer')?.clientWidth ?? 0 }));
  expect(scroll.page, 'the page has no sideways scroll').toBeLessThanOrEqual(width);
  expect(scroll.drawer, 'the panel has no sideways scroll').toBeLessThanOrEqual(scroll.inner);
}

for (const lang of CHECKED_LOCALES) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [1440, 375]) {
      test(`the default and saved approval rules fit, in ${lang}, ${theme}, at ${width}px`, async ({ page, browserName }, info) => {
        const start = Date.parse('2026-01-02T12:00:00Z');
        await page.clock.install({ time: start });
        await page.clock.pauseAt(start + 60_000);
        const t = MESSAGES[lang];
        const { errors } = await open(page, lang, theme, width);
        const part = section(page, t);
        const a = t.dept.approvals;
        await expect(part.getByText(a.defaultHint, { exact: true })).toBeVisible();
        await expect(part.getByRole('group', { name: a.channels.message, exact: true }).getByRole('combobox')).toHaveValue('new_kinds');
        await expect(part.getByRole('group', { name: a.channels.price, exact: true }).getByRole('combobox')).toHaveValue('every');
        await expect(part.getByRole('group', { name: a.channels.commit, exact: true }).getByRole('combobox')).toHaveValue('every');
        await fitsTheScreen(page, width);
        expect(await offences(part, { danger: [], groups: '.appr-limit' })).toEqual([]);
        await info.attach('shipped-locale-lengths', { body: JSON.stringify(LOCALE_LENGTHS), contentType: 'application/json' });
        await info.attach('geometry', { body: JSON.stringify(await sizes(part, PIECES)), contentType: 'application/json' });
        await part.screenshot({ path: info.outputPath(`approvals-default-${lang}-${theme}-${width}-${browserName}.png`) });
        expect(errors).toEqual([]);
      });

      test(`the CEO reads and changes the owner and the rules, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const { errors, puts } = await open(page, lang, theme, width);
        const part = section(page, t);
        await expect(part.getByText(t.dept.approvals.defaultHint, { exact: true })).toBeVisible();
        await info.attach('shipped-locale-lengths', { body: JSON.stringify(LOCALE_LENGTHS), contentType: 'application/json' });
        await page.screenshot({ path: info.outputPath(`approvals-page-${width}-${lang}-${theme}.png`) });
        await part.screenshot({ path: info.outputPath(`approvals-ceo-${width}-${lang}-${theme}.png`) });
        await fitsTheScreen(page, width);

        const a = t.dept.approvals;
        const owner = part.getByRole('combobox', { name: a.owner, exact: true });
        await expect(owner).toHaveValue('');
        await expect(part.getByRole('group', { name: a.channels.spend, exact: true }).getByRole('spinbutton', { name: a.limit, exact: true })).toHaveValue('100');

        await owner.selectOption('p2');
        await page.getByRole('alertdialog').getByRole('button', { name: a.confirm.owner.yes, exact: true }).click();
        await expect.poll(() => puts.at(-1)).toEqual({ url: '/api/departments/d2/owner', body: { personId: 'p2' } });
        await expect(owner).toHaveValue('p2');

        /* Someone the server refuses: the choice stays with the owner there is, and the reason shows in the dialog. */
        await owner.selectOption('p3');
        const refusedDialog = page.getByRole('alertdialog');
        await refusedDialog.getByRole('button', { name: a.confirm.owner.yes, exact: true }).click();
        await expect(refusedDialog.getByRole('alert')).toHaveText(t.errors.owner_no_access);
        await refusedDialog.getByRole('button', { name: t.common.cancel, exact: true }).click();
        await expect(owner).toHaveValue('p2');

        const price = part.getByRole('group', { name: a.channels.price, exact: true });
        await price.getByRole('combobox', { name: a.mode, exact: true }).selectOption('within_limits');
        await expect(price.getByRole('button', { name: t.common.save, exact: true })).toBeDisabled();
        await price.getByRole('spinbutton', { name: a.limit, exact: true }).fill('250');
        await price.getByRole('textbox', { name: a.unit, exact: true }).fill('USD');
        await price.getByRole('button', { name: t.common.save, exact: true }).click();
        await page.getByRole('alertdialog').getByRole('button', { name: a.confirm.rule.yes, exact: true }).click();
        await expect.poll(() => puts.at(-1)).toEqual({ url: '/api/departments/d2/approval-policy/price', body: { mode: 'within_limits', limit: 250, unit: 'USD' } });

        const autoSwitch = part.getByRole('switch', { name: a.autonomousRelease, exact: true });
        await expect(autoSwitch).not.toBeChecked();
        await autoSwitch.click();
        await page.getByRole('alertdialog').getByRole('button', { name: a.confirm.enableAutonomous.yes, exact: true }).click();
        await expect.poll(() => puts.at(-1)).toEqual({ url: '/api/departments/d2/approval-policy/autonomous-release', body: { enabled: true } });
        await expect(autoSwitch).toBeChecked();
        await expect(part.getByText('d7a1eb2b34edb970a2c5abbaadf25e50d4dc4031')).toBeVisible();

        await fitsTheScreen(page, width);
        await part.screenshot({ path: info.outputPath(`approvals-ceo-open-${width}-${lang}-${theme}.png`) });
        expect(errors.filter(e => !/400/.test(e))).toEqual([]);
      });

      test(`someone with access reads the rules and changes nothing, in ${lang}, ${theme}, at ${width}px`, async ({ page }, info) => {
        const t = MESSAGES[lang];
        const { errors } = await open(page, lang, theme, width, {
          ...POLICY,
          owner: { id: 'p2', name: 'Dana Abramovna Konstantinopolskaya' },
          canSetOwner: false,
          canChangePolicy: false,
          autonomousRelease: true,
          canSetAutonomousRelease: false,
          hasAutonomousReleases: true,
          candidates: [],
        });
        const part = section(page, t);
        await expect(part.getByText('d7a1eb2b34edb970a2c5abbaadf25e50d4dc4031')).toBeVisible();
        await part.screenshot({ path: info.outputPath(`approvals-reader-${width}-${lang}-${theme}.png`) });
        await fitsTheScreen(page, width);
        await expect(part.getByText(t.dept.approvals.ownerIs('Dana Abramovna Konstantinopolskaya'))).toBeVisible();
        await expect(part.getByText(t.dept.approvals.autonomousReleaseState(true))).toBeVisible();
        await expect(part.getByRole('combobox')).toHaveCount(0);
        await expect(part.getByRole('switch')).toHaveCount(0);
        await expect(part.getByRole('button')).toHaveCount(0);
        await expect(part.getByText(t.dept.approvals.limitIs(100, 'USD'))).toBeVisible();
        expect(errors).toEqual([]);
      });
    }
  }
}

/* The person who runs the department, not the CEO, in both skins, both languages, at a desk and on a phone, and right to
   left: the switch says its state in a word beside it, Design's rules hold, and the panel is drawn whole for Design. */
type Look = { lang: Language; skin: 'light' | 'cyberpunk'; width: number; dir: 'ltr' | 'rtl' };
const OWNER_LOOKS: Look[] = [
  ...CHECKED_LOCALES.flatMap(lang => (['light', 'cyberpunk'] as const).flatMap(skin => [1440, 375].map(width => ({ lang, skin, width, dir: 'ltr' as const })))),
  { lang: 'en', skin: 'light', width: 1440, dir: 'rtl' },
  { lang: 'ru', skin: 'cyberpunk', width: 375, dir: 'rtl' },
];
const PIECES = { owner: '.appr-owner', rules: '.appr-rules', rule: '.appr-rule', limit: '.appr-limit', save: '.appr-limit .btn', release: '.appr-auto', state: '.appr-auto-toggle .status' };

for (const { lang, skin, width, dir } of OWNER_LOOKS) {
  const mode = skin === 'light' ? 'light' : `dark ${skin}`;
  const look = `${lang}-${skin}-${width}-${dir}`;
  test(`the person who runs the department, not the CEO, switches its autonomous release, in ${lang}, ${mode}, at ${width}px${dir === 'rtl' ? ', right to left' : ''}`, async ({ page, browserName }, info) => {
    const t = MESSAGES[lang];
    const a = t.dept.approvals;
    const { errors, puts } = await open(page, lang, skin, width, {
      ...POLICY,
      owner: { id: 'p2', name: 'Dana Abramovna Konstantinopolskaya' },
      canSetOwner: false,
      candidates: [],
    }, dir);
    const part = section(page, t);
    const own = part.getByRole('switch', { name: a.autonomousRelease, exact: true });
    const line = part.locator('.appr-auto-toggle');
    await expect(own).not.toBeChecked();
    /* Off, said in a word beside the box, not by the box alone. */
    await expect(line).toContainText(a.autonomousReleaseWord(false));
    await expect(part.getByText(a.autonomousReleaseHint)).toBeVisible();
    await fitsTheScreen(page, width);
    const words = { danger: [], groups: '.appr-limit' };
    expect.soft(await offences(part, words)).toEqual([]);
    const measured: Measured[] = [{ browser: browserName, look, screen: 'approvals', sizes: await sizes(part, PIECES) }];
    await page.locator('.dv-drawer').screenshot({ path: info.outputPath(`approvals-panel-off-${look}-${browserName}.png`) });

    /* The keyboard reaches the switch and shows where it is. */
    await own.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect(own).toBeFocused();
    expect(await focusRing(page)).toBe('ring');
    await around(page, line, info.outputPath(`approvals-focus-${look}-${browserName}.png`));

    await own.click();
    await page.getByRole('alertdialog').getByRole('button', { name: a.confirm.enableAutonomous.yes, exact: true }).click();
    await expect.poll(() => puts.at(-1)).toEqual({ url: '/api/departments/d2/approval-policy/autonomous-release', body: { enabled: true } });
    await expect(own).toBeChecked();
    await expect(line).toContainText(a.autonomousReleaseWord(true));
    await expect(part.getByText('d7a1eb2b34edb970a2c5abbaadf25e50d4dc4031')).toBeVisible();
    await fitsTheScreen(page, width);
    expect.soft(await offences(part, words)).toEqual([]);
    measured.push({ browser: browserName, look, screen: 'approvals on', sizes: await sizes(part, PIECES) });
    writeFileSync(info.outputPath('sizes.json'), JSON.stringify(measured));
    await page.locator('.dv-drawer').screenshot({ path: info.outputPath(`approvals-panel-on-${look}-${browserName}.png`) });
    expect(errors).toEqual([]);
  });
}
