import { expect, test, type Locator, type Page } from '@playwright/test';
import { LANGUAGES, type ShippedLanguage, type Messages } from '../../src/i18n';
import { DICTIONARIES } from '../../src/i18n/dictionaries';
import { BUILTIN_SKINS, builtinSkin, DEFAULT_SKIN } from '../../src/skins/registry';
import { ME } from '../api';
import { captureWith } from '../capture';
import { MARIA_QUESTION, MAX_QUESTION, QUESTION, SALES, servePeopleWaits, serveTasksBoard, TASKS } from './api';

/* What waits for people in the company, as the CEO meets it in the tracker: every decision with whom it waits for, and its
   count beside it, while Waits for me keeps only the CEO's own. The look goes in the default skin and one of the other
   scheme, at a desk and on a phone, in the shipped languages with the longest and the shortest words on this page. Shots go
   to HH_SCREENSHOT_DIR when it is set, from Chromium, with one person's filter beside them. */

const capture = captureWith('people-waits', process.env.HH_SCREENSHOT_DIR);
const SKINS = [DEFAULT_SKIN, BUILTIN_SKINS.find(skin => skin.scheme !== builtinSkin(DEFAULT_SKIN)!.scheme)!.id];

/* The words this page shows in a language, summed: the panel's lists, the section and its cards. */
const pageWords = (t: Messages) => [
  t.tracker.side.title, t.tracker.side.waits, t.tracker.side.mine, t.tracker.side.working, t.tracker.side.people, t.tracker.side.departments,
  t.tracker.side.allGoals, t.tracker.side.dates, t.tracker.side.failures, t.tracker.side.orchestrator, t.tracker.side.turns, t.tracker.search.results,
  t.tracker.peopleWaits.title, t.tracker.peopleWaits.waitingFor(''), t.tracker.peopleWaits.tasks, t.tasks.asks(''), t.tasks.asksOther.choice(''),
  t.tasks.asksOther.approval(''), t.tasks.asksOther.approvalOf(''), t.tasks.decidedByNamedPerson,
  t.tasks.answerElsewhere, t.tasks.openTerminal(''), t.tracker.wait.person('', ''),
].join('').length;
const byLength = [...LANGUAGES].sort((a, b) => pageWords(DICTIONARIES[b.id]) - pageWords(DICTIONARIES[a.id]));
const LOOK_LANGUAGES = [...new Set([byLength[0]!.id, byLength[byLength.length - 1]!.id])];

async function open(page: Page, lang: ShippedLanguage, width: number, path: string, skin: string = DEFAULT_SKIN) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(({ language, skin }) => {
    localStorage.setItem('hh-lang', language);
    localStorage.setItem('hh-theme', skin);
  }, { language: lang, skin });
  await serveTasksBoard(page);
  await servePeopleWaits(page);
  await page.goto(path);
  await expect(page.locator('h1.tr-where')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/* The number at the end of a row of the panel. */
const countOn = async (side: Locator, name: string) => Number(await side.getByRole('button', { name: new RegExp(`^${name} \\d+$`) }).locator('.tr-count').textContent());

/* What a list of what waits shows, counted as its number counts it: each task once, whether it asks or waits, and every card
   without a task. */
async function listed(region: Locator) {
  const tasks = await region.locator('article.req, article.wait-question, .tr-waits li').evaluateAll(els => els.map(e => (e.getAttribute('aria-label') ?? e.textContent ?? '').match(/#(\d+)/)?.[1]));
  return new Set(tasks).size + await region.locator('.t-card').count();
}

test('lists what waits for people with whom each waits for, counts it, and keeps decisions assigned to others off Waits for me', async ({ page }) => {
  const t = DICTIONARIES.en;
  await open(page, 'en', 1440, '/tasks?show=waits');
  const side = page.getByRole('navigation', { name: t.tracker.side.label });
  const mine = page.getByRole('region', { name: t.tasks.waiting });
  await expect(mine).toContainText(QUESTION);
  await expect(mine).not.toContainText(MARIA_QUESTION);
  await expect(mine).not.toContainText(MAX_QUESTION);
  await expect(mine.locator('article.req')).toHaveCount(1);
  expect(await countOn(side, t.tracker.side.waits)).toBe(1 + await mine.getByRole('button', { expanded: false }).count());

  await side.getByRole('button', { name: new RegExp(`^${t.tracker.peopleWaits.title} \\d+$`) }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.peopleWaits.title);
  const people = page.getByRole('region', { name: t.tracker.peopleWaits.title });
  const card = (text: string) => people.locator('article', { hasText: text });
  await expect(card(MAX_QUESTION)).toContainText('Max');
  await expect(card(MAX_QUESTION)).toContainText(t.tasks.decidedByNamedPerson);
  await expect(card(QUESTION)).toContainText(t.tracker.peopleWaits.waitingFor('Ivan'));
  await expect(card(MARIA_QUESTION)).toContainText(t.tracker.peopleWaits.waitingFor('Maria'));
  await expect(people.getByRole('heading', { name: t.tracker.peopleWaits.tasks })).toBeVisible();
  expect(await countOn(side, t.tracker.peopleWaits.title)).toBe(await listed(people));
  /* The company also sees the decisions assigned to Maria and Max. */
  expect(await countOn(side, t.tracker.peopleWaits.title)).toBe(await countOn(side, t.tracker.side.waits) + 2);
});

test('names what waits for people once, in the title of the page', async ({ page }) => {
  const t = DICTIONARIES.en;
  await open(page, 'en', 1440, '/tasks?show=people');
  const people = page.getByRole('region', { name: t.tracker.peopleWaits.title });
  await expect(people.locator('article.wait-question', { hasText: MAX_QUESTION })).toContainText('Max');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.peopleWaits.title);
  await expect(page.getByRole('heading', { name: t.tracker.peopleWaits.title, exact: true })).toHaveCount(1);
});

test('shows what waits for one person under a title with their name alone, and Me takes the filter off', async ({ page }) => {
  const t = DICTIONARIES.en;
  await open(page, 'en', 1440, '/tasks?show=waits&person=p-max');
  const mine = page.getByRole('region', { name: t.tasks.waiting });
  await expect(mine).toContainText(MAX_QUESTION);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.where.waitsFor('Max'));
  /* What waits for other people has its own section, so the list neither names the person again nor offers everyone's
     decisions. */
  await expect(mine.getByText(/^Decisions for /)).toHaveCount(0);
  await page.getByRole('combobox', { name: t.tracker.viewAs }).selectOption({ label: t.tracker.viewAsSelf(ME.person.name) });
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(t.tracker.where.waits);
  await expect(mine).toContainText(QUESTION);
  await expect(mine).not.toContainText(MAX_QUESTION);
});

/* Each card and its words stay inside the main area, nothing cut short, and the page never scrolls sideways. A closed select
   shows its choice on one line, as every select of the app does. */
async function fitsInside(page: Page, region: Locator) {
  const frame = (await page.locator('.tr-main').boundingBox())!;
  for (const box of await region.locator('article.req, article.req header > *, article.wait-question, .tr-waits li').evaluateAll(els => els.map(e => e.getBoundingClientRect()).map(r => ({ x: r.x, right: r.right })))) {
    expect(box.x).toBeGreaterThanOrEqual(frame.x - 1);
    expect(box.right).toBeLessThanOrEqual(frame.x + frame.width + 1);
  }
  expect(await page.locator('.tracker :not(select)').evaluateAll(els => els.filter(e => getComputedStyle(e).textOverflow === 'ellipsis').length)).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

for (const lang of LOOK_LANGUAGES) for (const skin of SKINS) for (const width of [1440, 375]) {
  test(`shows what waits for people whole inside the screen: ${lang} ${skin} ${width}`, async ({ page, browserName }, info) => {
    const t = DICTIONARIES[lang];
    await open(page, lang, width, '/tasks?show=people', skin);
    const people = page.getByRole('region', { name: t.tracker.peopleWaits.title });
    await expect(people.locator('article.wait-question', { hasText: MAX_QUESTION })).toContainText('Max');
    await fitsInside(page, people);
    if (browserName === 'chromium') await capture(page, info, `${lang}-${skin}-${width}`);
  });
}

for (const lang of LOOK_LANGUAGES) for (const width of [1440, 375]) {
  test(`shows what waits for one person whole inside the screen: ${lang} ${width}`, async ({ page, browserName }, info) => {
    const t = DICTIONARIES[lang];
    await open(page, lang, width, '/tasks?show=waits&person=p-max');
    const mine = page.getByRole('region', { name: t.tasks.waiting });
    await expect(mine.locator('article.req', { hasText: MAX_QUESTION })).toBeVisible();
    await fitsInside(page, mine);
    if (browserName === 'chromium') await capture(page, info, `filter-${lang}-${DEFAULT_SKIN}-${width}`);
  });
}

for (const lang of LOOK_LANGUAGES) for (const width of [1440, 375]) {
  test(`does not address the viewer as you on another person's cards in Waiting for people while keeping it in Waiting for me: ${lang} ${width}`, async ({ page, browserName }, info) => {
    const t = DICTIONARIES[lang];
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ language, skin }) => {
      localStorage.setItem('hh-lang', language);
      localStorage.setItem('hh-theme', skin);
    }, { language: lang, skin: DEFAULT_SKIN });
    await serveTasksBoard(page);
    const base = await servePeopleWaits(page);
    const seed = base.requests.find(request => request.text === QUESTION)!;
    const makeReq = (id: string, title: string, text: string, extra: Partial<typeof seed>) => {
      const task = TASKS.find(item => item.title === title)!;
      return { ...seed, id, text, task: { id: task.id, number: task.number, title: task.title, department: task.department }, ...extra };
    };
    const options = [{ label: 'Botanical card', image: null }, { label: 'Moisture dial', image: null }];
    const commit = 'a'.repeat(40);
    const forMaria = { ownerPersonId: 'p2', canAnswer: true, decidedBy: { kind: 'department_and_ceo' as const, department: SALES } };
    const requests = [
      makeReq('r-m-choice', 'Take card payments', 'Pick the default card style.', { ...forMaria, kind: 'choice', options }),
      makeReq('r-m-commit', 'Refunds on request', 'Approve this release commit.', { ...forMaria, kind: 'approval', commit }),
      makeReq('r-m-policy', 'Receipts by email', 'Approve sending the launch email.', { ...forMaria, kind: 'approval', commit: null }),
      makeReq('r-m-question', 'Delivery dates', 'Keep the fallback carrier?', { ...forMaria, kind: 'question' }),
      makeReq('r-ro-choice', 'Old checkout', 'Pick the archive layout.', { ownerPersonId: 'p-max', canAnswer: false, decidedBy: { kind: 'department_and_ceo' as const, department: SALES }, kind: 'choice', options }),
      makeReq('r-i-choice', 'Gift cards', 'Pick your gift card wording.', { ownerPersonId: ME.person.id, canAnswer: true, kind: 'choice', options }),
      makeReq('r-i-commit', 'Rename the shop', 'Approve your release commit.', { ownerPersonId: ME.person.id, canAnswer: true, kind: 'approval', commit }),
      makeReq('r-i-policy', 'Pay in parts', 'Approve your department spend.', { ownerPersonId: ME.person.id, canAnswer: true, kind: 'approval', commit: null }),
    ];
    await page.route('**/api/requests', route => route.fulfill({ json: { ...base, requests, counts: { ...base.counts, total: requests.filter(r => r.canAnswer).length } } }));

    await page.goto('/tasks?show=people');
    await expect(page.locator('h1.tr-where')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const people = page.getByRole('region', { name: t.tracker.peopleWaits.title });
    for (const [text, personName, expected] of [
      ['Pick the default card style.', 'Maria', t.tasks.asksOther.choice('Hana')],
      ['Approve this release commit.', 'Maria', t.tasks.asksOther.approval('Hana')],
      ['Approve sending the launch email.', 'Maria', t.tasks.asksOther.approvalOf('Hana')],
      ['Keep the fallback carrier?', 'Maria', t.tasks.asksOther.question('Hana')],
      ['Pick the archive layout.', 'Max', t.tasks.asksOther.choice('Hana')],
    ] as const) {
      const header = people.locator('article.req', { hasText: text }).locator('header');
      await expect(header).toContainText(t.tracker.peopleWaits.waitingFor(personName));
      await expect(header).toContainText(expected);
      await expect(header).not.toContainText(/\basks you\b|просит вас/i);
    }
    await fitsInside(page, people);
    if (browserName === 'chromium') await capture(page, info, `headings-people-${lang}-${width}`);

    await page.goto('/tasks?show=waits');
    await expect(page.locator('h1.tr-where')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const mine = page.getByRole('region', { name: t.tasks.waiting });
    const firstHeader = mine.locator('article.req header');
    await expect(firstHeader).toContainText(t.tasks.asksOther.choice('Hana'));
    await expect(firstHeader).not.toContainText(/\basks you\b|просит вас/i);
    /* Viewer's own cards keep direct phrasing in Waiting for me. */
    await mine.getByRole('button', { name: /Pick your gift card wording/, expanded: false }).click();
    await expect(firstHeader).toContainText(t.tasks.asksChoice('Hana'));
    await mine.getByRole('button', { name: /Approve your release commit/, expanded: false }).click();
    await expect(firstHeader).toContainText(t.tasks.asksApproval('Hana'));
    await mine.getByRole('button', { name: /Approve your department spend/, expanded: false }).click();
    await expect(firstHeader).toContainText(t.tasks.asksApprovalOf('Hana'));
    await fitsInside(page, mine);
    if (browserName === 'chromium') await capture(page, info, `headings-mine-${lang}-${width}`);
  });
}
