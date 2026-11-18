import { expect, type Locator, type Page } from '@playwright/test';
import type { Messages } from '../../src/i18n';
import { MOONFERN_PIPELINE } from './pipelines';

/* The map also has a move handle for each department. Open the card itself. */
export function mapDepartment(page: Page, name: string): Locator {
  return page.locator('button.dept').filter({ has: page.getByText(name, { exact: true }) });
}

export async function expectBetaBoard(board: Locator, t: Messages): Promise<Locator> {
  const stages = MOONFERN_PIPELINE.stages.map(stage => stage.name);
  await expect.poll(() => board.getByRole('region').evaluateAll(columns => columns.map(column => column.getAttribute('aria-label')))).toEqual([
    t.tracker.statuses.notStarted, ...stages, t.tracker.statuses.done,
  ]);
  const smoke = board.getByRole('region', { name: stages.at(-1), exact: true });
  await expect(smoke.getByRole('article', { name: '#214 Run iOS beta smoke suite on TestFlight build' })).toBeVisible();
  return smoke;
}
