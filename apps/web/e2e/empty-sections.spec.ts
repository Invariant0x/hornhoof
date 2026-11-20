import { expect, test, type Locator, type Page } from '@playwright/test';
import { DICTIONARIES } from '../src/i18n';
import { boxesOf, ELSEWHERE, expectSameBoxes, FAIL_MS, HEADED_ORG, LONGEST, NO_DECISIONS, openTracker, RING_DELAY_MS, RING_MIN_MS, SHORTEST, shownEmpty, SLOW_MS, type Look } from './empty-sections';
import { TASKS } from './tasks-board/api';

/* Ivan's word (20.11, #1638): on Mine, "No open tasks to answer for." stood right under the filters, and loading showed as a
   thin strip. Design #1633 (style book 1.7, section 4): every section of the tracker that holds nothing says so in its own
   empty block, apart from what is above it by the tracker's spacing; the block shares one room with what holds the section's
   place while it comes, so nothing moves when the section came, empty or not; and it shows only once every source of the
   section came. Checked in the longest and the shortest language the product ships, on a phone and on a wide screen. */
test.describe.configure({ timeout: 0 });

const LOOKS: Look[] = [...new Set([SHORTEST, LONGEST])].flatMap(lang => [375, 1440].map(width => ({ lang, width })));
const nameOf = (look: Look) => `${look.lang} ${look.width}`;

/* The server's answers for a company whose work is all elsewhere: Mine, Development and the rest hold nothing. */
const EMPTY = { '/api/tasks': { tasks: ELSEWHERE }, '/api/requests': NO_DECISIONS, '/api/wait-cards': { cards: [], next: null }, '/api/goals': { goals: [] } };

/* What stands above a block: the bar of views and filters, else the page's top, else the heading of its section. */
async function bottomAbove(page: Page, block: Locator): Promise<number> {
  return block.evaluate(el => {
    const top = el.getBoundingClientRect().top;
    const above = [...document.querySelectorAll('.tr-top, .tr-bar, .tr-main h2')].map(e => e.getBoundingClientRect()).filter(r => r.height > 0 && r.bottom <= top + 0.5);
    return Math.max(...above.map(r => r.bottom));
  });
}

for (const look of LOOKS) {
  test.describe(`tracker sections that hold nothing, ${nameOf(look)}`, () => {
    const t = DICTIONARIES[look.lang];
    /* The heading of Waiting for you: Mine with tasks also shows Waiting for people, a section of the same kind. */
    const waitsHead = (page: Page) => page.locator('section.waiting').getByRole('heading', { level: 2, name: t.tasks.waiting, exact: true });

    test('Mine holds its list and Waiting for you in place while the tasks come; once they came empty nothing moves', async ({ page }) => {
      const held = await openTracker(page, '/tasks', look, EMPTY, ['/api/tasks']);
      await page.clock.runFor(RING_DELAY_MS);
      const room = page.locator('.tr-hold .room');
      const waits = waitsHead(page);
      const parts = [page.locator('.tr-bar'), room, waits];
      await expect(page.locator('.tr-held .spinner')).toBeVisible();
      const before = await boxesOf(parts);
      /* No source is all there yet, so neither section says it holds nothing. */
      await expect(shownEmpty(page)).toHaveCount(0);
      await expect(page.getByText(t.tracker.empty.mine, { exact: true })).toBeHidden();
      await expect(page.getByText(t.tracker.empty.waits, { exact: true })).toBeHidden();
      held['/api/tasks']!.release();
      await page.clock.runFor(RING_MIN_MS);
      await expect(shownEmpty(room).getByText(t.tracker.empty.mine, { exact: true })).toBeVisible();
      await expect(shownEmpty(page.locator('section.waiting')).getByText(t.tracker.empty.waits, { exact: true })).toBeVisible();
      expectSameBoxes(await boxesOf(parts), before);
    });

    test('Mine says nothing waits for you only once the kept cards came too, and its room keeps its height', async ({ page }) => {
      const held = await openTracker(page, '/tasks', look, EMPTY, ['/api/wait-cards']);
      await expect(shownEmpty(page.locator('.tr-hold')).getByText(t.tracker.empty.mine, { exact: true })).toBeVisible();
      await page.clock.runFor(RING_DELAY_MS);
      const section = page.locator('section.waiting');
      const parts = [section.locator('> h2'), section.locator('.room')];
      await expect(section.locator('.load-busy .spinner')).toBeVisible();
      await expect(section.getByText(t.tracker.empty.waits, { exact: true })).toBeHidden();
      const before = await boxesOf(parts);
      held['/api/wait-cards']!.release();
      await page.clock.runFor(RING_MIN_MS);
      await expect(shownEmpty(section).getByText(t.tracker.empty.waits, { exact: true })).toBeVisible();
      expectSameBoxes(await boxesOf(parts), before);
    });

    for (const [section, path, source] of [
      ['Working now', '/tasks?show=working', '/api/org'],
      ['a graph', '/tasks?department=d2&view=graph', '/api/goals'],
    ] as const) {
      test(`${section} says it holds nothing only once ${source} came`, async ({ page }) => {
        const held = await openTracker(page, path, look, EMPTY, [source]);
        await page.clock.runFor(RING_DELAY_MS);
        await expect(page.locator('.tr-hold .spinner')).toBeVisible();
        await expect(shownEmpty(page)).toHaveCount(0);
        held[source]!.release();
        await page.clock.runFor(RING_MIN_MS);
        await expect(shownEmpty(page.locator('.tr-hold'))).toBeVisible();
      });
    }

    for (const [section, path] of [
      ['Mine', '/tasks'], ['a department', '/tasks?department=d2'], ['Working now', '/tasks?show=working'], ['Failures', '/tasks?show=failures'],
      ['the goals', '/tasks?show=goals'], ['Waiting for you', '/tasks?show=waits'], ['Waiting for people', '/tasks?show=people'], ['Due dates', '/tasks?show=due'],
    ] as const) {
      test(`${section} stands its empty words apart from what is above them by the tracker's spacing`, async ({ page }) => {
        await openTracker(page, path, look, EMPTY);
        const block = shownEmpty(page).first();
        await expect(block).toBeVisible();
        const spacing = await page.locator('.tr-main').evaluate(el => getComputedStyle(el).getPropertyValue('--empty-top').trim());
        expect(spacing).toBe('16px');
        expect(await block.evaluate(el => getComputedStyle(el).paddingBlockStart)).toBe(spacing);
        const [box, words] = await boxesOf([block, block.locator('.empty-state-t')]);
        expect(box!.y).toBeGreaterThanOrEqual((await bottomAbove(page, block)) - 0.5);
        expect(words!.y - box!.y).toBeGreaterThanOrEqual(16 - 0.5);
        /* Its words wrap inside it, and its action is a finger's size. */
        expect(await block.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        for (const button of await block.getByRole('button').all()) expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44 - 0.5);
      });
    }

    test('Mine holds the height its list showed last in this tab, so Waiting for you does not move when the tasks come again', async ({ page }) => {
      const held = await openTracker(page, '/tasks', look, { ...EMPTY, '/api/tasks': { tasks: TASKS } }, ['/api/tasks']);
      held['/api/tasks']!.release();
      await expect(page.locator('.tr-list:not(.tr-held) .tr-row').first()).toBeVisible();
      const asked = held['/api/tasks']!.asked();
      held['/api/tasks']!.again();
      await page.reload({ waitUntil: 'domcontentloaded' });
      /* The clock moves only once the page asked again, so the ring's timer is set by then. */
      await expect.poll(held['/api/tasks']!.asked).toBeGreaterThan(asked);
      await page.clock.runFor(RING_DELAY_MS);
      await expect(page.locator('.tr-held .spinner')).toBeVisible();
      const waits = waitsHead(page);
      const before = await boxesOf([page.locator('.tr-bar'), waits]);
      held['/api/tasks']!.release();
      await page.clock.runFor(RING_MIN_MS);
      await expect(page.locator('.tr-list:not(.tr-held) .tr-row').first()).toBeVisible();
      expectSameBoxes(await boxesOf([page.locator('.tr-bar'), waits]), before);
    });

    test('Mine keeps its room past 10 s and once given up, the block that says so over its first rows', async ({ page }) => {
      await openTracker(page, '/tasks', look, EMPTY, ['/api/tasks']);
      await page.clock.runFor(RING_DELAY_MS);
      const room = page.locator('.tr-hold .room');
      const parts = [room, waitsHead(page)];
      const before = await boxesOf(parts);
      for (const [ms, block] of [[SLOW_MS - RING_DELAY_MS, '.load-fail.slow'], [FAIL_MS - SLOW_MS, '.load-fail:not(.slow)']] as const) {
        await page.clock.runFor(ms);
        await expect(page.locator(`.tr-held-rows > ${block}`)).toBeVisible();
        expectSameBoxes(await boxesOf(parts), before);
      }
    });

    test('a company with no task at all opens on its first view under the Hornhoof mark, in the middle', async ({ page }) => {
      /* Development has a head, so the person may make the company's first task. */
      await openTracker(page, '/tasks', look, { ...EMPTY, '/api/tasks': { tasks: [] }, '/api/org': HEADED_ORG });
      const block = shownEmpty(page.locator('.tr-hold')).first();
      await expect(block).toHaveClass(/\bfirst\b/);
      await expect(block.getByText(t.tracker.empty.company, { exact: true })).toBeVisible();
      await expect(block.getByRole('button', { name: t.tracker.empty.create, exact: true })).toBeVisible();
      const [box, mark] = await boxesOf([block, block.locator('svg.load-mark')]);
      expect(Math.abs(mark!.width - 48)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(mark!.x + mark!.width / 2 - (box!.x + box!.width / 2))).toBeLessThanOrEqual(1);
    });
  });
}
