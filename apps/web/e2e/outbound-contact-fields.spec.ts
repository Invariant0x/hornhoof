import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { LANGUAGES } from '../src/i18n';
import { BUILTIN_SKINS } from '../src/skins/registry';
import { serveRoutes } from './routes-api';
import { messagesFor, watchProblems } from './look-steps';

/* Rank the actual shipped words rendered by the add/import forms, including their validation and results. */
const lengthOf = (value: unknown): number => typeof value === 'string' ? value.length : typeof value === 'function' ? String(value(2, 3, 4)).length : value && typeof value === 'object' ? Object.values(value).reduce<number>((n, child) => n + lengthOf(child), 0) : 0;
const dictionaries = await Promise.all(LANGUAGES.map(async language => ({ ...language, words: await messagesFor(language.id) })));
const ranked = dictionaries.map(language => ({ ...language, length: lengthOf(language.words.outboundSetup.contact) })).sort((a, b) => a.length - b.length);
const extremes = [...new Map([ranked[0]!, ranked.at(-1)!].map(language => [language.id, language])).values()];
const CHANNEL = { id: 'contact-channel', departmentId: 'd2', name: 'Partner letters', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', status: 'active', canManage: true, accounts: [], policy: null };

async function open(page: Page, language: typeof extremes[number], skin: typeof BUILTIN_SKINS[number], width: number) {
  const t = language.words;
  const c = t.outboundSetup.contact;
  const errors = watchProblems(page);
  const posts: unknown[] = [];
  await page.clock.install({ time: new Date('2026-11-17T11:00:00Z') });
  await page.setViewportSize({ width, height: 1000 });
  await page.addInitScript(({ language, skin }) => { localStorage.setItem('hh-lang', language); localStorage.setItem('hh-theme', skin); }, { language: language.id, skin: skin.id });
  await serveRoutes(page);
  await page.route('**/api/outbound**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/outbound') return route.fulfill({ json: { channels: [CHANNEL], departments: [{ id: 'd2', name: 'Development' }], messages: [], approvals: [], escalations: [] } });
    if (path === '/api/outbound/catalog') return route.fulfill({ json: { entries: [] } });
    if (path === '/api/outbound/setup-log') return route.fulfill({ json: { entries: [] } });
    if (path === '/api/outbound/contacts' && route.request().method() === 'POST') { posts.push(route.request().postDataJSON()); return route.fulfill({ json: { contactId: 'one', permissionId: 'permission' } }); }
    if (path === '/api/outbound/contacts') return route.fulfill({ json: { contacts: [] } });
    if (path === '/api/outbound/contacts/import') return route.fulfill({ json: { added: 1, updated: 0, skipped: [{ row: 3, reason: 'consent_missing' }] } });
    throw new Error(`Unhandled route ${path}`);
  });
  await page.goto('/settings/messaging');
  await expect(page.getByRole('button', { name: c.add, exact: true })).toBeVisible();
  await page.clock.pauseAt(new Date('2026-11-17T12:00:00Z'));
  return { c, errors, posts };
}

for (const language of extremes) for (const skin of BUILTIN_SKINS) for (const width of [375, 1440]) {
  test(`contact values ${language.id} ${skin.id} ${width}`, async ({ page }, info) => {
    const { c, errors, posts } = await open(page, language, skin, width);
    await page.getByRole('button', { name: c.add, exact: true }).click();
    const form = page.getByRole('form', { name: c.add, exact: true });
    await form.getByLabel(c.email, { exact: true }).fill('ann@shop.example');
    await form.getByLabel(c.source, { exact: true }).fill('Signup form');
    await form.getByLabel(c.evidence, { exact: true }).fill('Recorded consent');
    await form.getByRole('checkbox').check();
    await form.getByLabel(`${c.fieldName} 1`, { exact: true }).fill('name');
    await form.getByLabel(`${c.fieldValue} 1`, { exact: true }).fill('Ann');
    await form.getByRole('button', { name: c.addField, exact: true }).click();
    const fieldName = form.getByLabel(`${c.fieldName} 2`, { exact: true });
    await fieldName.fill('personal_line');
    const fieldValue = form.getByLabel(`${c.fieldValue} 2`, { exact: true });
    await fieldValue.fill('Thank you for visiting.');
    await page.evaluate(async () => { await document.fonts.ready; });
    const fits = async () => expect(await form.evaluate(root => {
      const box = root.getBoundingClientRect();
      return [...root.querySelectorAll('input, textarea, button, .field, .entry-actions')].filter(el => { const r = el.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }).map(el => el.tagName);
    })).toEqual([]);
    await fits();
    await page.setViewportSize({ width, height: 2000 });
    await form.screenshot({ path: info.outputPath('add-fields.png') });
    await page.setViewportSize({ width, height: 1000 });
    await fieldName.fill('invalid name');
    await form.getByRole('button', { name: c.submit, exact: true }).click();
    await expect(fieldName).toBeFocused();
    await expect(fieldName).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByText(c.fieldNameInvalid, { exact: true })).toBeVisible();
    await fits();
    await fieldName.locator('xpath=ancestor::div[contains(@class, "field")][1]').screenshot({ path: info.outputPath('field-error-focus.png') });
    writeFileSync(info.outputPath('geometry.json'), JSON.stringify({ language: { id: language.id, length: language.length }, skin: skin.id, width, browser: info.project.name, form: await form.boundingBox(), focus: await fieldName.evaluate(el => { const s = getComputedStyle(el); return { color: s.color, border: s.borderColor, outline: s.outlineColor }; }) }, null, 2));
    await fieldName.fill('personal_line');
    await form.getByRole('button', { name: c.submit, exact: true }).click();
    await expect(page.getByText(c.added('ann@shop.example'), { exact: true })).toBeVisible();
    expect(posts).toEqual([{ channelId: CHANNEL.id, kind: 'email', address: 'ann@shop.example', source: 'Signup form', evidence: 'Recorded consent', fields: { name: 'Ann', personal_line: 'Thank you for visiting.' } }]);
    expect(errors).toEqual([]);
  });

  test(`contact import ${language.id} ${skin.id} ${width}`, async ({ page }, info) => {
    const { c, errors } = await open(page, language, skin, width);
    await page.getByRole('button', { name: c.importAddresses, exact: true }).click();
    const importing = page.getByRole('form', { name: c.importAddresses, exact: true });
    await importing.getByLabel(c.file, { exact: true }).setInputFiles({ name: 'contacts.csv', mimeType: 'text/csv', buffer: Buffer.from('address,consent,name\nann@shop.example,yes,Ann') });
    await importing.getByLabel(c.source, { exact: true }).fill('Signup form');
    await importing.getByLabel(c.evidence, { exact: true }).fill('Recorded consent');
    await importing.getByRole('button', { name: c.importSubmit, exact: true }).click();
    await expect(importing.getByRole('status')).toHaveText(c.importSummary(1, 0, 1));
    await expect(importing.getByText(c.importRow(3, c.importReasons.consent_missing))).toBeVisible();
    expect(await importing.evaluate(root => { const box = root.getBoundingClientRect(); return [...root.querySelectorAll('input, textarea, button')].some(el => { const r = el.getBoundingClientRect(); return r.left < box.left - 1 || r.right > box.right + 1; }); })).toBe(false);
    await page.setViewportSize({ width, height: 2000 });
    await importing.screenshot({ path: info.outputPath('import-report.png') });
    expect(errors).toEqual([]);
  });
}
