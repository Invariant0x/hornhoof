import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Measured } from './outbound-setup-edges';
import { edges, fits, offences, shooter, small, type Words } from './outbound-setup-look';
import { serveRoutes } from './routes-api';

/* A department's own outbound setup as the people who run it meet it, in Settings and on the department's screen: every
   panel fits its width with nothing cut, in English and Russian, left to right and right to left, wide and narrow. The
   pictures are for the check against the style book. */
test.use({ reducedMotion: 'reduce' });
const SHOTS = 'e2e/results/outbound-setup-shots';
mkdirSync(SHOTS, { recursive: true });
const shot = shooter(SHOTS);

const DEPT = 'd2';
const POLICY = {
  timezone: 'Europe/Berlin', accountDailyLimit: 40, domainDailyLimit: 200, autoSend: true,
  sampling: { matureAfter: 20, firstPerSegment: 1, firstPerAuthor: 3, everyNth: 10 },
  circuit: { windowHours: 24, minimumSample: 20, maxComplaints: 1, maxRefusals: 3, maxBounces: 5 },
};
const CHANNELS = [
  {
    id: 'ch1', departmentId: DEPT, productId: null, name: 'Spring letters to partner shops in the northern region', adapter: 'smtp', purpose: 'first_contact', audience: 'direct', status: 'new', generation: 1,
    stoppedReason: null, stoppedAt: null, canManage: true, policy: { revision: 2, value: POLICY },
    accounts: [{ id: 'ac1', label: 'Spring sale', senderDomain: 'letters.northern-region-partner-shops.example', status: 'active', configGeneration: 1, available: false, author: { agentId: 'a-max', name: 'Max', generation: 1 } }],
  },
  { id: 'ch2', departmentId: DEPT, productId: null, name: 'Announcements', adapter: 'webhook', purpose: 'newsletter', audience: 'public', status: 'stopped', generation: 2, stoppedReason: 'channel_stopped', stoppedAt: '2026-01-02T00:00:00.000Z', canManage: true, policy: null, accounts: [] },
];
const rev = (id: string, n: number, status: string, extra: object = {}) => ({
  id, revision: n, status, value: {}, summary: 'Spring sale: twenty percent off every order placed before the end of March', validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: { kind: 'agent', id: 'a-max', name: 'Max' }, publishedBy: null, publishedVia: null, publishedAt: null, revokedAt: null, ...extra,
});
const CATALOG = {
  departmentId: DEPT,
  entries: [
    { entryId: 'e1', kind: 'template', locale: 'en', productId: null, channel: null, current: 1, revisions: [rev('r2', 2, 'proposed'), rev('r1', 1, 'published', { publishedBy: { id: 'p1', name: 'Ivan' }, publishedVia: { id: 'a-mia', name: 'Mia' } })] },
    { entryId: 'e2', kind: 'unsubscribe', locale: 'en', productId: null, channel: { id: 'ch1', name: 'Spring letters to partner shops in the northern region' }, current: null, revisions: [rev('r3', 1, 'revoked')] },
  ],
};
const LOG = {
  departmentId: DEPT,
  entries: [
    { id: 'l2', kind: 'auto_send_on', channel: { id: 'ch1', name: 'Spring letters to partner shops in the northern region' }, subjectId: null, detail: {}, person: { id: 'p1', name: 'Ivan' }, agent: { id: 'a-mia', name: 'Mia' }, at: '2026-01-02T10:00:00.000Z' },
    { id: 'l1', kind: 'account_set_up', channel: { id: 'ch1', name: 'Spring letters to partner shops in the northern region' }, subjectId: null, detail: {}, person: { id: 'p1', name: 'Ivan' }, agent: null, at: '2026-01-02T09:00:00.000Z' },
  ],
};
/* The addresses on the first channel: a long one that agreed, added by Ivan through Mia, and one whose consent was taken back. */
const CONTACTS = [
  { permissionId: 'pm2', channelId: 'ch1', kind: 'email', address: 'purchasing.department.northern-region@partner-shop-with-a-long-name.example', purpose: 'first_contact', source: 'Signup form on the partner portal', status: 'granted', grantedAt: '2026-01-03T09:00:00.000Z', revokedAt: null, doNotContact: false, addedBy: { person: { id: 'p1', name: 'Ivan' }, agent: { id: 'a-mia', name: 'Mia' } } },
  { permissionId: 'pm1', channelId: 'ch1', kind: 'email', address: 'old.list@shop.example', purpose: 'first_contact', source: 'Signup form', status: 'revoked', grantedAt: '2026-01-02T09:00:00.000Z', revokedAt: '2026-01-02T12:00:00.000Z', doNotContact: false, addedBy: null },
];
const OVERVIEW = { channels: CHANNELS, messages: [], escalations: [], approvals: [], departments: [{ id: DEPT, name: 'Development', templateKey: null }] };

async function serve(page: Page, published: string[]) {
  await serveRoutes(page);
  await page.route('**/api/outbound**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/outbound') return route.fulfill({ json: OVERVIEW });
    if (url.pathname === '/api/outbound/catalog') return route.fulfill({ json: CATALOG });
    if (url.pathname === '/api/outbound/setup-log') return route.fulfill({ json: LOG });
    if (url.pathname === '/api/outbound/contacts') return route.fulfill({ json: { contacts: CONTACTS } });
    if (url.pathname.endsWith('/publish') && route.request().method() === 'POST') {
      published.push(url.pathname);
      return route.fulfill({ json: { id: 'r2', status: 'published' } });
    }
    return route.fallback();
  });
}

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; width: number };
const LOOKS: Look[] = [
  { lang: 'en', dir: 'ltr', width: 1440 }, { lang: 'en', dir: 'ltr', width: 375 },
  { lang: 'ru', dir: 'ltr', width: 1440 }, { lang: 'ru', dir: 'ltr', width: 375 },
  { lang: 'en', dir: 'rtl', width: 1440 }, { lang: 'en', dir: 'rtl', width: 375 },
];

async function open(page: Page, { lang, dir, width }: Look) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, dir }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', 'light');
    /* Right to left as a shipped RTL language would set it; the app sets lang itself. */
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { lang, dir });
}

for (const look of LOOKS) {
  const t = look.lang === 'en' ? en : ru;
  const name = `${look.lang}-${look.dir}-${look.width}`;
  const statuses = [...Object.values(t.outbound.channelStatuses), ...Object.values(t.outboundSetup.accountStatuses), ...Object.values(t.outboundSetup.statuses)];
  const words: Words = { statuses: [...statuses, ...Object.values(t.outboundSetup.contact.statuses)], danger: [t.outboundSetup.stop, t.outboundSetup.revoke, t.outboundSetup.contact.revoke], entryBlocks: [t.outboundSetup.catalogTitle, t.outboundSetup.logTitle] };
  test(`a department's own outbound setup in Settings and on its screen ${name}`, async ({ page, browserName }) => {
    test.setTimeout(0);
    const published: string[] = [];
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await open(page, look);
    await serve(page, published);
    await page.goto('/settings/messaging');
    const dialog = page.getByRole('dialog', { name: t.settings.title, exact: true });
    const part = dialog.getByRole('region', { name: t.outboundSetup.title('Development') });
    const block = (title: string) => part.getByRole('region', { name: title });
    await expect(block(t.outboundSetup.catalogTitle)).toBeVisible();
    await expect(part.getByText(t.outboundSetup.byVia('Ivan', 'Mia')).first()).toBeVisible();
    await fits(page, part);
    expect.soft(await offences(part, words)).toEqual([]);
    const measured: Measured[] = [{ browser: browserName, look: name, screen: 'settings', ...(await edges(part)) }];
    await shot(page, block(t.outboundSetup.channelsTitle), `settings-channels-${browserName}-${name}`);
    await shot(page, part.getByRole('list', { name: t.outboundSetup.contact.listTitle }), `settings-addresses-${browserName}-${name}`);
    await shot(page, block(t.outboundSetup.catalogTitle), `settings-catalog-${browserName}-${name}`);
    await shot(page, block(t.outboundSetup.logTitle), `settings-log-${browserName}-${name}`);

    await part.getByRole('button', { name: t.outboundSetup.changePolicy }).click();
    await part.getByRole('button', { name: t.outboundSetup.connectHook }).click();
    await part.getByRole('button', { name: t.outboundSetup.newChannel }).click();
    const policy = part.getByRole('form', { name: t.outboundSetup.policyTitle });
    await expect(policy.getByRole('checkbox')).toBeChecked();
    await expect(part.getByRole('form', { name: t.outboundSetup.newChannel }).getByRole('combobox')).toHaveCount(2);
    expect(await small(part)).toEqual([]);
    expect.soft(await offences(part, { ...words, danger: [] })).toEqual([]);
    await fits(page, part);
    await shot(page, policy, `settings-policy-form-${browserName}-${name}`);
    await shot(page, part.getByRole('form', { name: t.outboundSetup.connectHook }), `settings-account-form-${browserName}-${name}`);

    /* The part reads its catalog and log again after a publish; leaving before that ends cancels them, which WebKit
       reports as a page error. */
    const reread = (path: string) => page.waitForResponse(r => new URL(r.url()).pathname === path);
    await Promise.all([reread('/api/outbound/catalog'), reread('/api/outbound/setup-log'), reread('/api/outbound/contacts'), part.getByRole('button', { name: t.outboundSetup.publish }).click()]);
    await expect.poll(() => published).toEqual(['/api/outbound/catalog/r2/publish']);

    await page.goto(`/departments/${DEPT}`);
    await page.getByRole('button', { name: t.settings.groups.messaging, exact: true }).click();
    /* The part itself, under the panel's own head and its close button. */
    const own = page.getByRole('complementary', { name: t.settings.groups.messaging }).locator('.outbound-setup');
    await expect(own.getByRole('heading', { name: t.outboundSetup.channelsTitle })).toBeVisible();
    await fits(page, own);
    await shot(page, own.getByRole('heading', { name: t.outboundSetup.channelsTitle }), `department-${browserName}-${name}`);
    expect(await small(own)).toEqual([]);
    expect.soft(await offences(own, words)).toEqual([]);
    measured.push({ browser: browserName, look: name, screen: 'department', ...(await edges(own)) });
    writeFileSync(test.info().outputPath('edges.json'), JSON.stringify(measured));
    expect(errors).toEqual([]);
  });
}
