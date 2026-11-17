import { expect, test } from '@playwright/test';
import type { CallMark, Org } from '../../src/types';
import { MOONFERN_ORG } from '../moonfern/agents';
import { isoMinutes } from '../moonfern/clock';
import { createSceneRecorder } from '../moonfern/record';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { CARE_PLANTS } from '../moonfern/tasks';
import { reportUnmocked, smoothScrollTo } from '../moonfern/tracker-scene';

/* Marketing's SEO specialist Jonah writes thirty care pages at once: one one-shot call per plant, lit on the map while it
   runs and pale while it waits for memory, then a judge call that reads all thirty. The task's history keeps every call. */
const TASK = 237;
const mark = (number: number, running: boolean, judge = false): CallMark => ({
  id: `call-${number}`, number, judge, task: TASK, by: 'mkt-seo', stage: null, startedAt: running ? isoMinutes(-1) : null,
});
/* The calls still alive: from the first one not yet answered to the last, the first `running` of them running. */
function withCalls(answered: number, running: number, judge = false): Org {
  const calls = judge
    ? [mark(CARE_PLANTS.length + 1, true, true)]
    : CARE_PLANTS.map((_, i) => i + 1).filter(n => n > answered).map((n, i) => mark(n, i < running));
  return { ...MOONFERN_ORG, departments: MOONFERN_ORG.departments.map(d => (d.id === 'dept-mkt' ? { ...d, calls } : d)) };
}

test('calls.gif: thirty one-shot calls on the map, then their answers in the task history', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const api = await serveMoonfern(page, { initialOrg: withCalls(0, 12) });

  await page.goto('/');
  await expect(page.locator('.hub')).toBeVisible();
  const marks = page.locator('.cells.calls');
  await expect(marks).toBeVisible();
  await page.waitForTimeout(600);
  await recorder.markReady();
  await page.waitForTimeout(1200);

  /* More calls get memory and start; the first ones answer and go; then only the judge runs. */
  for (const [answered, running, judge] of [[0, 20, false], [9, 21, false], [22, 8, false], [30, 0, true]] as const) {
    api.setOrg(withCalls(answered, running, judge));
    await pushStream(page, { type: 'org' });
    await page.waitForTimeout(1100);
  }

  /* The task's history: each call's brief, input and answer, and the judge's verdict on all thirty. */
  await page.evaluate(id => {
    history.pushState({ hhBackground: '/' }, '', `/tasks/${id}`);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, `t-${TASK}`);
  const judge = page.getByText('Jonah ran a judge call').first();
  await expect(judge).toBeAttached();
  await page.waitForTimeout(900);
  await smoothScrollTo(page, judge, 120, 16, 45);
  await page.waitForTimeout(2300);

  /* Back to the map as the loop began. */
  await page.keyboard.press('Escape');
  api.setOrg(withCalls(0, 12));
  await pushStream(page, { type: 'org' });
  await page.mouse.move(8, 8);
  await page.waitForTimeout(900);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('calls');
});
