import { expect, test, type Page } from '@playwright/test';
import { expectStripsApart, openCompany } from './agent-windows-api';

/* Throwaway: the steps of agent-windows.spec.ts :130, each with a diagnostic limit, for what it waits on. */
async function snap(page: Page, what: string) {
  const d = await page.evaluate(() => {
    const r = (el: Element | null) => (el ? (b => [b.left, b.top, b.right, b.bottom].map(Math.round).join(','))(el.getBoundingClientRect()) : null);
    const strips = document.querySelector('.agent-strips');
    return {
      vp: [innerWidth, innerHeight], docW: document.documentElement.scrollWidth,
      strips: r(strips), stripScroll: strips ? { sw: strips.scrollWidth, cw: strips.clientWidth, sh: strips.scrollHeight, ch: strips.clientHeight, sl: strips.scrollLeft, st: strips.scrollTop } : null,
      stripEls: [...document.querySelectorAll('.agent-strip')].map(el => `${(el.textContent ?? '').trim().slice(0, 18)}:${r(el)}`),
      windows: [...document.querySelectorAll('aside')].map(el => `${String(el.className).slice(0, 30)}:${r(el)}:${getComputedStyle(el).display}`),
      topbar: [...document.querySelectorAll('.topbar > *')].map(el => r(el)),
      members: [...document.querySelectorAll('[aria-label] button')].filter(b => /Bruno|Clara|Dana|Egor/.test(b.textContent ?? '')).map(b => `${(b.textContent ?? '').trim().slice(0, 10)}:${r(b)}`).slice(0, 8),
    };
  });
  console.log(`SNAP ${what} ${JSON.stringify(d)}`);
  if (process.env.HH_OUT) await page.screenshot({ path: `${process.env.HH_OUT}/probe-${what.replace(/\W+/g, '-')}.png` });
}

for (const width of [1440, 375]) {
  test(`probe 1930 at ${width}`, async ({ page }) => {
    const { windowOf, stripOf, anyStrip, openEmployee, minimize } = await openCompany(page, { lang: 'ru', theme: 'dark', width });
    const step = async (what: string, run: () => Promise<unknown>) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('stood 20 s')), 20000); })]);
        console.log(`STEP ok ${what}`);
      } catch (e) {
        console.log(`STEP FAIL ${what}: ${(e as Error).message.split('\n')[0]}`);
        await snap(page, what);
        throw e;
      } finally { clearTimeout(timer); }
    };
    const names = ['Bruno', 'Clara', 'Dana', 'Egor'];
    for (const name of names) {
      await step(`open ${name}`, () => openEmployee(name));
      await step(`minimize ${name}`, () => minimize(name));
    }
    await snap(page, 'after-minimizing');
    await step('four strips', () => expect(anyStrip).toHaveCount(4));
    await page.setViewportSize({ width, height: 420 });
    await snap(page, 'after-resize');
    for (const name of names) {
      await step(`scroll ${name}`, () => stripOf(name).scrollIntoViewIfNeeded());
      await step(`in viewport ${name}`, () => expect(stripOf(name)).toBeInViewport());
    }
    await step('apart', async () => expectStripsApart(page, names.map(stripOf)));
    await step('click Egor', () => stripOf('Egor').click());
    await step('Egor window', () => expect(windowOf('Egor')).toBeVisible());
  });
}
