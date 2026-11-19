import { expect, test } from '@playwright/test';
import type { CallMark, Org } from '../../src/types';
import { MOONFERN_ORG } from '../moonfern/agents';
import { isoMinutes } from '../moonfern/clock';
import { createSceneRecorder } from '../moonfern/record';
import { CARE_PIPELINE } from '../moonfern/pipelines';
import { mapDepartment } from '../moonfern/scene-locators';
import { serveMoonfern } from '../moonfern/serve';
import { prepareScenePage, pushStream } from '../moonfern/stream';
import { CARE_PLANTS } from '../moonfern/tasks';
import { reportUnmocked, smoothScrollTo } from '../moonfern/tracker-scene';

/* Marketing's SEO specialist Jonah writes thirty care pages at once. The stage shows each call running, waiting or idle.
   The judge reads all thirty, and the task's full log keeps their answers. */
const TASK = 237;
const mark = (number: number, running: boolean, judge = false): CallMark => ({
  id: `call-${number}`, number, judge, task: TASK, by: 'mkt-seo',
  pipelineId: CARE_PIPELINE.id, stage: 'development', startedAt: running ? isoMinutes(-1) : null,
});
/* The calls still alive: from the first one not yet answered to the last, the first `running` of them running. */
function withCalls(answered: number, running: number, judge = false): Org {
  const calls = judge
    ? [mark(CARE_PLANTS.length + 1, true, true)]
    : CARE_PLANTS.map((_, i) => i + 1).filter(n => n > answered).map((n, i) => mark(n, i < running));
  return { ...MOONFERN_ORG, departments: MOONFERN_ORG.departments.map(d => (d.id === 'dept-mkt' ? { ...d, calls } : d)) };
}

test('calls.gif: thirty stage diamonds, then their answers and judge in the full task log', async ({ page }) => {
  const recorder = createSceneRecorder(page);
  const watcher = await prepareScenePage(page);
  const api = await serveMoonfern(page, { initialOrg: withCalls(0, 12) });

  await page.goto('/');
  const marketing = mapDepartment(page, 'Marketing');
  await expect(marketing.locator('.cells .cell').first()).toBeVisible();
  await expect(marketing.locator('[data-worker-kind="ghost"]')).toHaveCount(0);
  await marketing.click();
  /* The staff schema draws the one-shot stage of Marketing's default route, Houseplant care guides, as a frame of its own
     named after the stage, with a diamond for each of its thirty calls and one for the judge. */
  const schema = page.getByRole('region', { name: 'Department schema', exact: true });
  const stage = schema.getByRole('group', { name: 'Development', exact: true });
  const marks = stage.locator('[data-worker-kind="ghost"]');
  await expect(marks).toHaveCount(31);
  await expect(marks.and(stage.locator('.running'))).toHaveCount(12);
  await expect(marks.and(stage.locator('.waiting'))).toHaveCount(18);
  await recorder.markReady();
  await page.waitForTimeout(1200);

  /* More calls get memory and start; the first ones answer and go; then only the judge runs. */
  for (const [answered, running, judge] of [[0, 20, false], [9, 21, false], [22, 8, false], [30, 0, true]] as const) {
    api.setOrg(withCalls(answered, running, judge));
    await pushStream(page, { type: 'org' });
    await expect(marks.and(stage.locator('.running'))).toHaveCount(judge ? 1 : running);
    await page.waitForTimeout(800);
  }
  const judgeMark = stage.getByRole('img', { name: /Judge call\. Running$/ });
  await expect(judgeMark).toBeInViewport();
  await page.waitForTimeout(650);

  /* The task's history: each call's brief, input and answer, and the judge's verdict on all thirty. */
  await page.evaluate(id => {
    history.pushState({ hhBackground: location.pathname }, '', `/tasks/${id}`);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, `t-${TASK}`);
  const card = page.getByRole('complementary', { name: '#237 Care guide pages for 30 common houseplants', exact: true });
  await card.getByRole('button', { name: 'Task actions' }).click();
  await card.getByRole('button', { name: 'Full log', exact: true }).click();
  const log = card.getByRole('list', { name: 'Full log', exact: true });
  await expect(log.locator('li.call')).toHaveCount(31);
  const judge = log.getByRole('listitem').filter({ hasText: 'Jonah ran a judge call' });
  await expect(judge).toContainText('Verdict: passed.');
  await smoothScrollTo(page, judge, 120, 16, 45);
  await page.waitForTimeout(2300);

  /* Back to the opening stage and call counts. */
  await card.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(schema).toBeVisible();
  api.setOrg(withCalls(0, 12));
  await pushStream(page, { type: 'org' });
  await page.mouse.move(8, 8);
  await page.waitForTimeout(900);

  reportUnmocked(watcher.errors);
  await recorder.finishGif('calls');
});
