import { mkdirSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { Org, PersonView } from '../src/types';
import { ME } from './api';
import { fits, offences, shooter, small, type Words } from './outbound-setup-look';
import { serveRoutes } from './routes-api';

/* A person given several departments but not the whole company, who owns Marketing, opens its screen, finds its External
   messaging there, sees its channel, publishes a template of its catalog and adds a test address with the consent the
   channel's purpose asks for; About the department leads to the same panel. Every look: English and Russian, left to
   right and right to left, Cyberpunk and Light, wide and narrow. The pictures are for Design's check. */
test.use({ reducedMotion: 'reduce' });
const SHOTS = 'e2e/results/department-messaging-shots';
mkdirSync(SHOTS, { recursive: true });
const shot = shooter(SHOTS);

const MKT = 'd-mkt';
const GIVEN = [{ id: MKT, name: 'Marketing' }, { id: 'd-sal', name: 'Sales' }, { id: 'd-sup', name: 'Support' }, { id: 'd-biz', name: 'Business development' }];
const MAX: PersonView & { deputy: boolean; departments: string[] } = {
  id: 'p-max', name: 'Max', email: 'max@acme.test', title: 'CMO', status: 'active', isOwner: false, deputy: true, departments: GIVEN.map(d => d.id), access: { whole: false, departments: GIVEN, teams: [] },
};
const ME_MAX = { ...ME, person: { ...ME.person, id: MAX.id, name: MAX.name, email: MAX.email!, title: MAX.title, scopeKind: 'listed' as const, isOwner: false } };
const department = (id: string, templateKey: 'marketing' | 'sales' | 'support' | null, name: string | null, position: number) => ({
  id, name, templateKey, roleCode: ['MKT', 'SAL', 'SUP', 'BIZ'][position]!, about: '', agents: { total: 0, working: 0 }, products: [], teams: [], people: [], employees: [], roles: [], ownerPersonId: id === MKT ? MAX.id : null,
});
const ORG: Org = {
  company: ME.company, orchestrator: null, agents: { total: 0, working: 0 }, people: [MAX],
  departments: [department(MKT, 'marketing', null, 0), department('d-sal', 'sales', null, 1), department('d-sup', 'support', null, 2), department('d-biz', null, 'Business development', 3)],
};

const POLICY = {
  timezone: 'Europe/Berlin', accountDailyLimit: 40, domainDailyLimit: 200, autoSend: false,
  sampling: { matureAfter: 20, firstPerSegment: 1, firstPerAuthor: 3, everyNth: 10 },
  circuit: { windowHours: 24, minimumSample: 20, maxComplaints: 1, maxRefusals: 3, maxBounces: 5 },
};
const CHANNEL = {
  id: 'ch-b2c', departmentId: MKT, productId: null, name: 'B2C Email Outreach', adapter: 'smtp', purpose: 'newsletter', audience: 'direct', status: 'active', generation: 1,
  stoppedReason: null, stoppedAt: null, canManage: true, policy: { revision: 1, value: POLICY },
  accounts: [{ id: 'ac1', label: 'Outreach', senderDomain: 'letters.acme.test', status: 'active', configGeneration: 1, available: false, author: null }],
};
/* A template the shop sends, its second revision waiting: other words, a new subject, and the way to stop messages added. */
const SPRING = { kind: 'template', locale: 'en', subject: 'Spring sale', parts: [{ kind: 'text', text: 'Twenty percent off every order placed before the end of March. ' }, { kind: 'slot', slotId: 's1', type: 'price' }] };
const LAST_DAYS = {
  kind: 'template', locale: 'en', subject: 'Spring sale, last days',
  parts: [{ kind: 'text', text: 'Twenty percent off every order placed before Sunday, 31 March. ' }, { kind: 'slot', slotId: 's1', type: 'price' }, { kind: 'text', text: ' ' }, { kind: 'slot', slotId: 's2', type: 'unsubscribe' }],
};
const revision = (id: string, n: number, value: object, published: boolean) => ({
  id, revision: n, status: published ? 'published' : 'proposed', value, summary: (value as { subject: string }).subject, validFrom: '2026-01-01T00:00:00.000Z', validUntil: null,
  createdAt: `2026-03-0${n}T09:30:00.000Z`, createdBy: { kind: 'agent', id: 'a-mia', name: 'Mia' },
  publishedBy: published ? { id: MAX.id, name: 'Max' } : null, publishedVia: null, publishedAt: null, revokedAt: null,
});
const catalog = (published: boolean) => ({
  departmentId: MKT,
  entries: [{ entryId: 'e1', kind: 'template', locale: 'en', productId: null, channel: null, current: published ? 2 : 1, revisions: [revision('r2', 2, LAST_DAYS, published), revision('r1', 1, SPRING, true)] }],
});
const OVERVIEW = { channels: [CHANNEL], messages: [], escalations: [], approvals: [], departments: [{ id: MKT, name: null, templateKey: 'marketing' }] };
const TEST_ADDRESS = 'max.test@acme.test';

type Posted = { path: string; body: unknown };

/* The server as such a person meets it: their own company and themselves, and the department's messages to run. */
async function serve(page: Page, posted: Posted[]) {
  await serveRoutes(page);
  let published = false;
  /* The address Max adds, as the server lists it: agreed once added, its consent taken back once he takes it back. */
  let added: 'no' | 'granted' | 'revoked' = 'no';
  const contacts = () => (added === 'no' ? [] : [{
    permissionId: 'pm1', channelId: 'ch-b2c', kind: 'email', address: TEST_ADDRESS, purpose: 'newsletter', source: 'Test address of our team', status: added,
    grantedAt: '2026-03-02T09:30:00.000Z', revokedAt: added === 'revoked' ? '2026-03-02T10:00:00.000Z' : null, doNotContact: false, addedBy: { person: { id: MAX.id, name: 'Max' }, agent: null },
  }]);
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/me') return route.fulfill({ json: ME_MAX });
    if (url.pathname === '/api/org') return route.fulfill({ json: ORG });
    if (route.request().method() === 'POST' && url.pathname.startsWith('/api/outbound/')) {
      posted.push({ path: url.pathname, body: route.request().postDataJSON() });
      if (url.pathname === '/api/outbound/catalog/r2/publish') {
        published = true;
        return route.fulfill({ json: { id: 'r2', status: 'published' } });
      }
      if (url.pathname === '/api/outbound/contacts') {
        added = 'granted';
        return route.fulfill({ json: { contactId: 'k1', permissionId: 'pm1' } });
      }
      if (url.pathname === '/api/outbound/permissions/pm1/revoke') {
        added = 'revoked';
        return route.fulfill({ json: { permissionId: 'pm1', status: 'revoked' } });
      }
    }
    if (url.pathname === '/api/outbound' && url.searchParams.get('department') === MKT) return route.fulfill({ json: OVERVIEW });
    if (url.pathname === '/api/outbound/catalog') return route.fulfill({ json: catalog(published) });
    if (url.pathname === '/api/outbound/setup-log') return route.fulfill({ json: { departmentId: MKT, entries: [] } });
    if (url.pathname === '/api/outbound/contacts') return route.fulfill({ json: { departmentId: MKT, contacts: contacts() } });
    return route.fallback();
  });
}

/* Whether an English or Russian phrase is drawn in the order it reads: its first sign before the second and its closing
   dot after its last word. In a right to left block a number that opens such a phrase and a dot that closes it jump to
   the other end unless the phrase is isolated. */
const readsInOrder = (phrase: Locator) =>
  phrase.evaluate(el => {
    const text = el.firstChild as Text;
    const box = (from: number) => {
      const range = document.createRange();
      range.setStart(text, from);
      range.setEnd(text, from + 1);
      return range.getBoundingClientRect();
    };
    const last = text.data.length - 1;
    return box(0).left < box(1).left && box(last).left > box(last - 1).left;
  });

/* Where the lines of the empty head card start, as drawn: its role line, its "No head yet." and its count. */
const startEdges = (card: Locator) =>
  card.evaluate(el => {
    const rtl = getComputedStyle(el).direction === 'rtl';
    const textBox = (node: Element) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    };
    const boxes = [el.querySelector('.hr')!.firstElementChild!.getBoundingClientRect(), textBox(el.querySelector('.hn')!), textBox(el.querySelector('.meta')!)];
    return boxes.map(b => Math.round(rtl ? b.right : b.left));
  });

/* What covers the hint: the bottom buttons it meets, and whether a point of its words shows something else on top. */
const covered = (hint: Locator) =>
  hint.evaluate(el => {
    const box = el.getBoundingClientRect();
    const meets = [...document.querySelectorAll('.dv-acts > *')].filter(b => {
      const r = b.getBoundingClientRect();
      return r.left < box.right && box.left < r.right && r.top < box.bottom && box.top < r.bottom;
    }).map(b => (b.textContent ?? '').trim() || b.getAttribute('aria-label'));
    const points = [[box.left + 8, box.top + box.height / 2], [box.left + box.width / 2, box.top + box.height / 2], [box.right - 8, box.top + box.height / 2]];
    const hidden = points.filter(([x, y]) => !el.contains(document.elementFromPoint(x!, y!))).length;
    return { meets, hidden, width: Math.round(box.width), inset: [Math.round(box.left), Math.round(innerWidth - box.right)] };
  });

type Look = { lang: 'en' | 'ru'; dir: 'ltr' | 'rtl'; theme: 'cyberpunk' | 'light'; width: number };
const LOOKS: Look[] = (['cyberpunk', 'light'] as const).flatMap(theme =>
  [1440, 375].flatMap(width => [{ lang: 'en', dir: 'ltr', theme, width }, { lang: 'ru', dir: 'ltr', theme, width }, { lang: 'en', dir: 'rtl', theme, width }] as Look[]),
);

async function open(page: Page, { lang, dir, theme, width }: Look) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ lang, dir, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    /* Right to left as a shipped RTL language would set it; the app sets lang itself. */
    if (dir === 'rtl') document.addEventListener('DOMContentLoaded', () => { document.documentElement.dir = 'rtl'; });
  }, { lang, dir, theme });
}

for (const look of LOOKS) {
  const t = look.lang === 'en' ? en : ru;
  const s = t.outboundSetup;
  const c = s.contact;
  const name = `${look.lang}-${look.dir}-${look.theme}-${look.width}`;
  const words: Words = { statuses: [...Object.values(t.outbound.channelStatuses), ...Object.values(s.accountStatuses), ...Object.values(s.statuses)], danger: [s.stop], entryBlocks: [s.catalogTitle, s.logTitle] };
  test(`a person given several departments runs the External messaging of the department they own from its screen ${name}`, async ({ page, browserName }) => {
    test.setTimeout(0);
    const posted: Posted[] = [];
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await open(page, look);
    await serve(page, posted);
    await page.goto(`/departments/${MKT}`);
    /* The map of a department with no head and no employees: its words keep their dot at their end (Design #1186). */
    const noHead = page.locator('.shead.empty .hn');
    await expect(noHead).toHaveText(t.dept.noHead);
    const hint = page.getByText(t.dept.noMembers, { exact: true });
    const counts = page.locator('.shead.empty .meta');
    expect(await readsInOrder(noHead)).toBe(true);
    expect(await readsInOrder(hint)).toBe(true);
    expect(await readsInOrder(counts)).toBe(true);
    /* The card's lines start at one edge, and on a narrow screen the hint stands whole above the bottom buttons (#1201). */
    expect(new Set(await startEdges(page.locator('.shead.empty'))).size).toBe(1);
    if (look.width <= 760) await expect.poll(() => covered(hint)).toEqual({ meets: [], hidden: 0, width: look.width - 32, inset: [16, 16] });
    await page.screenshot({ path: `${SHOTS}/map-${browserName}-${name}.png`, animations: 'disabled' });
    await page.getByRole('button', { name: t.settings.groups.messaging, exact: true }).click();
    const panel = page.getByRole('complementary', { name: t.settings.groups.messaging });
    const part = panel.locator('.outbound-setup');
    const card = part.locator('.imp').filter({ has: page.getByRole('heading', { name: 'B2C Email Outreach' }) });
    await expect(card).toBeVisible();
    await expect(panel.getByRole('heading', { name: s.catalogTitle })).toBeVisible();
    await fits(page, panel);
    expect(await small(part)).toEqual([]);
    expect.soft(await offences(part, words)).toEqual([]);
    await shot(page, card, `channel-${browserName}-${name}`);
    await shot(page, panel.getByRole('heading', { name: s.catalogTitle }), `catalog-${browserName}-${name}`);

    /* The channel's addresses are a block of their own under its buttons, with a heading that counts them (Design #1193). */
    const addresses = card.locator('.outbound-contacts');
    await expect(addresses.getByRole('heading', { name: c.listTitle(0), exact: true })).toBeVisible();
    await expect(addresses.getByText(c.none, { exact: true })).toBeVisible();
    const buttonsEnd = (await card.getByRole('button', { name: s.stop, exact: true }).boundingBox())!;
    const blockStart = (await addresses.boundingBox())!;
    expect(buttonsEnd.y + buttonsEnd.height).toBeLessThanOrEqual(blockStart.y);
    await shot(page, addresses, `address-none-${browserName}-${name}`);

    /* The waiting revision is open at once: its subject, its words with the places a message fills in, its language and
       who proposed it, and what changed from the revision messages use. */
    const shown = panel.getByRole('region', { name: s.revision(2) });
    await expect(shown.getByText('Spring sale, last days', { exact: true })).toBeVisible();
    await expect(shown.locator('.outbound-facts .outbound-slot').filter({ hasText: s.slots.unsubscribe })).toBeVisible();
    await expect(shown).toContainText(s.view.proposed('Mia', ''));
    const changed = shown.getByRole('group', { name: s.view.changesFrom(1) });
    await expect(changed.locator('ins').first()).toHaveText('sale, last days');
    await expect(changed.locator('del').first()).toHaveText('sale');
    await fits(page, panel);
    expect(await small(part)).toEqual([]);
    await shown.evaluate(el => el.scrollIntoView({ block: 'start' }));
    await shot(page, shown, `revision-${browserName}-${name}`);

    /* The part reads its catalog and log again after a publish; leaving before that ends cancels them, which WebKit
       reports as a page error. */
    const reread = (path: string) => page.waitForResponse(r => new URL(r.url()).pathname === path);
    await Promise.all([reread('/api/outbound/catalog'), reread('/api/outbound/setup-log'), reread('/api/outbound/contacts'), shown.getByRole('button', { name: s.publish, exact: true }).click()]);
    await expect(shown.getByRole('button', { name: s.revoke, exact: true })).toBeVisible();
    await expect(panel.getByText(s.inUse(2))).toBeVisible();
    await expect(shown).toContainText(s.view.inUseNow);

    await card.getByRole('button', { name: c.add, exact: true }).click();
    const form = card.getByRole('form', { name: c.add });
    const address = form.getByLabel(c.email, { exact: true });
    await address.fill('max test');
    await form.getByRole('button', { name: c.submit, exact: true }).click();
    await expect(address).toBeFocused();
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await expect(address).toHaveAccessibleDescription(c.notEmail);
    expect(await small(form)).toEqual([]);
    await fits(page, panel);
    expect.soft(await offences(part, { ...words, danger: [] })).toEqual([]);
    await address.evaluate(el => el.scrollIntoView({ block: 'center' }));
    await page.screenshot({ path: `${SHOTS}/address-error-${browserName}-${name}.png`, animations: 'disabled' });

    await address.fill(TEST_ADDRESS);
    await form.getByLabel(c.source, { exact: true }).fill('Test address of our team');
    await form.getByLabel(c.evidence, { exact: true }).fill('My own address, to try the letters');
    await form.getByRole('checkbox').check();
    await shot(page, form, `address-form-${browserName}-${name}`);
    await Promise.all([reread('/api/outbound/contacts'), reread('/api/outbound/setup-log'), form.getByRole('button', { name: c.submit, exact: true }).click()]);
    expect(posted).toEqual([
      { path: '/api/outbound/catalog/r2/publish', body: { revision: 2, newest: 2 } },
      { path: '/api/outbound/contacts', body: { channelId: 'ch-b2c', kind: 'email', address: TEST_ADDRESS, source: 'Test address of our team', evidence: 'My own address, to try the letters' } },
    ]);
    /* What adding said stands right under the entry it added. */
    await expect(card.getByRole('listitem').filter({ hasText: TEST_ADDRESS }).getByRole('status')).toHaveText(c.added(TEST_ADDRESS));
    await fits(page, panel);
    await shot(page, card, `address-added-${browserName}-${name}`);

    /* The address is on the channel's list, agreed and added by Max; he takes its consent back there. */
    await expect(addresses.getByRole('heading', { name: c.listTitle(1), exact: true })).toBeVisible();
    const listed = addresses.getByRole('list');
    const line = listed.getByRole('listitem').filter({ hasText: TEST_ADDRESS });
    await expect(line).toContainText(c.statuses.granted);
    expect(await small(line)).toEqual([]);
    await fits(page, panel);
    const listWords = { ...words, statuses: [...words.statuses, ...Object.values(c.statuses)] };
    expect.soft(await offences(part, { ...listWords, danger: [s.stop, c.revoke] })).toEqual([]);
    await shot(page, listed, `address-agreed-${browserName}-${name}`);
    await Promise.all([reread('/api/outbound/contacts'), reread('/api/outbound/setup-log'), line.getByRole('button', { name: c.revoke, exact: true }).click()]);
    await expect(line).toContainText(c.statuses.revoked);
    await expect(line.getByRole('button')).toHaveCount(0);
    /* Taking back says so in place of what adding said, and the heading counts only consent in force (#1201). */
    await expect(line.getByRole('status')).toHaveText(c.takenBack(TEST_ADDRESS));
    await expect(card.getByRole('status')).toHaveCount(1);
    await expect(addresses.getByRole('heading', { name: c.listTitle(0), exact: true })).toBeVisible();
    expect(posted.at(-1)).toEqual({ path: '/api/outbound/permissions/pm1/revoke', body: {} });
    await fits(page, panel);
    expect.soft(await offences(part, { ...listWords, danger: [] })).toEqual([]);
    await shot(page, listed, `address-taken-back-${browserName}-${name}`);

    /* A narrow screen gives the panel all of its width, over the buttons: it closes first. */
    await panel.getByRole('button', { name: t.dept.close, exact: true }).click();
    await page.getByRole('button', { name: t.dept.about, exact: true }).click();
    const pointer = page.getByRole('complementary', { name: t.dept.about }).getByRole('region', { name: t.settings.groups.messaging });
    await expect(pointer.getByRole('heading', { name: 'B2C Email Outreach' })).toHaveCount(0);
    await fits(page, pointer);
    await shot(page, pointer, `about-${browserName}-${name}`);
    await pointer.getByRole('button', { name: t.dept.openMessaging, exact: true }).click();
    await expect(page.getByRole('complementary', { name: t.settings.groups.messaging }).getByRole('heading', { name: 'B2C Email Outreach' })).toBeVisible();
    expect(errors).toEqual([]);
  });
}
