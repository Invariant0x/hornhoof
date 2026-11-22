/* Stage 7 Playwright verification:
   1) Company-wide CEO theme in Company & access (no personal theme picker in Appearance & language)
   2) Bulk era renaming preview & confirmation dialog + restore original names
   3) Non-CEO member has zero personal theme choice and syncs to company theme
   4) Simple human-friendly quick chat popup on clicking a resident in Egypt and Dungeon packs */

import { expect, test } from '@playwright/test';
import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ME, serveApi } from './api';

const OUT_DIR = process.env.HH_OUT || join(process.cwd(), 'e2e', 'results', 'stage7-out');

function exportShot(srcPath: string, filename: string): void {
  mkdirSync(OUT_DIR, { recursive: true });
  copyFileSync(srcPath, join(OUT_DIR, filename));
}

test.describe('Stage 7 world skills, company theme, era names, and simple agent quick chat', () => {
  test('CEO switches company theme in Company & access, previews & confirms era renaming, and non-CEO has no theme picker', async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'ru');
      localStorage.setItem('hh-theme', 'cyberpunk');
    });

    let currentTheme = 'cyberpunk';
    let renamedAgentsCount = 0;

    await serveApi(page);
    await page.route('**/api/me', route =>
      route.fulfill({
        json: {
          ...ME,
          company: { ...ME.company, theme: currentTheme },
        },
      }),
    );
    await page.route('**/api/world/theme', route => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON() as { theme: string };
        currentTheme = body.theme;
        const restoredNamesCount = currentTheme === 'egypt' ? 0 : renamedAgentsCount;
        if (currentTheme !== 'egypt') renamedAgentsCount = 0;
        return route.fulfill({
          json: {
            theme: currentTheme,
            activePack:
              currentTheme === 'egypt'
                ? { id: 'egypt', label: { en: 'Ancient Egypt', ru: 'Древний Египет' }, skillIds: ['world-egypt-voice'] }
                : null,
            canEdit: true,
            renamedAgentsCount,
            ...(restoredNamesCount > 0 ? { restoredNamesCount } : {}),
          },
        });
      }
      return route.fulfill({
        json: {
          theme: currentTheme,
          activePack:
            currentTheme === 'egypt'
              ? { id: 'egypt', label: { en: 'Ancient Egypt', ru: 'Древний Египет' }, skillIds: ['world-egypt-voice'] }
              : null,
          canEdit: true,
          renamedAgentsCount,
        },
      });
    });
    await page.route('**/api/world/rename-preview*', route =>
      route.fulfill({
        json: {
          packId: 'egypt',
          packLabel: { en: 'Ancient Egypt', ru: 'Древний Египет' },
          lang: 'ru',
          alreadyRenamedCount: renamedAgentsCount,
          items: [
            { agentId: 'a1', kind: 'orchestrator', currentName: 'Orchestrator', proposedName: 'Фараон Хеопс', preservedOriginalName: 'Orchestrator' },
            { agentId: 'a2', kind: 'head', currentName: 'Head of development', proposedName: 'Имхотеп', preservedOriginalName: 'Head of development' },
            { agentId: 'a3', kind: 'worker', currentName: 'Tank', proposedName: 'Нефертари', preservedOriginalName: 'Tank' },
            { agentId: 'a4', kind: 'worker', currentName: 'Trinity', proposedName: 'Птаххотеп', preservedOriginalName: 'Trinity' },
            { agentId: 'a5', kind: 'worker', currentName: 'Neo', proposedName: 'Хатшепсут', preservedOriginalName: 'Neo' },
          ],
        },
      }),
    );
    await page.route('**/api/world/rename-agents', route => {
      renamedAgentsCount = 5;
      return route.fulfill({
        json: {
          packId: 'egypt',
          lang: 'ru',
          renamedCount: 5,
          items: [],
        },
      });
    });
    await page.route('**/api/world/restore-names', route => {
      renamedAgentsCount = 0;
      return route.fulfill({
        json: {
          restoredCount: 5,
          items: [],
        },
      });
    });

    await page.goto('/settings');
    const settingsDialog = page.getByRole('dialog', { name: 'Настройки' });
    await expect(settingsDialog.getByRole('combobox', { name: 'Язык' })).toBeVisible();
    /* Personal theme picker is removed from Appearance & language. */
    await expect(settingsDialog.getByRole('region', { name: 'Каталог тем' })).toHaveCount(0);

    const noPersonalPath = info.outputPath('stage7-no-personal-theme-picker.png');
    await page.screenshot({ path: noPersonalPath, animations: 'disabled' });
    exportShot(noPersonalPath, 'stage7-no-personal-theme-picker.png');

    /* Open Company & access as CEO and activate Ancient Egypt for the whole company. */
    await settingsDialog.getByRole('button', { name: 'Компания и доступ' }).click();
    await expect(settingsDialog.getByRole('region', { name: 'Каталог тем' })).toBeVisible();
    await settingsDialog.getByRole('button', { name: 'Включить: Древний Египет' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'egypt');
    const renameBtn = settingsDialog.getByRole('button', { name: 'Переименовать агентов по эпохе' });
    await expect(renameBtn).toBeVisible();
    await renameBtn.scrollIntoViewIfNeeded();

    const ceoThemePath = info.outputPath('stage7-ceo-company-theme.png');
    await page.screenshot({ path: ceoThemePath, animations: 'disabled' });
    exportShot(ceoThemePath, 'stage7-ceo-company-theme.png');

    /* Open rename preview confirmation modal and capture screenshot. */
    await renameBtn.click();
    const renameDialog = page.getByRole('dialog', { name: 'Переименовать агентов по эпохе мира?' });
    await expect(renameDialog.getByText('Фараон Хеопс')).toBeVisible();
    await expect(renameDialog.getByText('Имхотеп')).toBeVisible();
    await expect(renameDialog.getByText('Нефертари')).toBeVisible();

    const renameDialogPath = info.outputPath('stage7-rename-confirm-dialog.png');
    await page.screenshot({ path: renameDialogPath, animations: 'disabled' });
    exportShot(renameDialogPath, 'stage7-rename-confirm-dialog.png');

    /* Confirm bulk rename, verify status & restore button, then turn Egypt off and verify auto-restore message. */
    await renameDialog.getByRole('button', { name: 'Да, переименовать' }).click();
    await expect(settingsDialog.getByRole('status')).toContainText('Переименовано агентов: 5.');
    await expect(settingsDialog.getByRole('button', { name: 'Вернуть прежние имена' })).toBeVisible();

    await settingsDialog.getByRole('button', { name: 'Включить: Киберпанк' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'cyberpunk');
    await expect(settingsDialog.getByRole('status')).toContainText('Прежние имена агентов возвращены (5).');
  });

  test('clicking a resident on the active world map opens the real AgentWindow in conversation view with level strip and world voice', async ({ page }, info) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 1366, height: 860 });
    await page.addInitScript(() => {
      localStorage.setItem('hh-lang', 'ru');
      localStorage.setItem('hh-theme', 'egypt');
      localStorage.setItem('hh-agent-view', 'terminal');
    });

    await serveApi(page);
    const posted: string[] = [];
    await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: 'egypt' } } }));
    await page.route('**/api/org', route =>
      route.fulfill({
        json: {
          company: { ...ME.company, theme: 'egypt' },
          orchestrator: null,
          agents: { total: 1, working: 1 },
          people: [],
          departments: [
            {
              id: 'dept-dev',
              name: 'Development',
              templateKey: 'development',
              roleCode: 'DEV',
              about: '',
              agents: { total: 1, working: 1 },
              products: [],
              teams: [],
              people: [],
              employees: [
                {
                  id: 'agent-dev-1',
                  name: 'Имхотеп',
                  roleId: 'DEV-ENG',
                  turnkey: false,
                  title: { en: 'Developer', ru: 'Разработчик' },
                  kind: 'worker',
                  model: 'claude-opus-5-5',
                  modelName: 'claude-opus-5-5',
                  provider: 'claude',
                  effort: 'high',
                  state: 'working',
                  status: 'working',
                  on: true,
                  timer: null,
                  task: null,
                  context: 0.25,
                  program: null,
                  alarm: null,
                  retry: null,
                  failure: null,
                },
              ],
              roles: [],
              pipelines: [],
              calls: [],
            },
          ],
        },
      }),
    );
    await page.route('**/api/world/state', route =>
      route.fulfill({
        json: {
          company: { id: ME.company.id, name: ME.company.name, seed: 'hornhoof', templateKey: 'startup', acceptedTasksTotal: 120, residenceStage: 2, oneShotCallsTotal: 0 },
          departments: [{ id: 'dept-dev', name: 'Development', templateKey: 'development', roleCode: 'DEV', acceptedTasks: 44, stage: 3, statuesCount: 1, currentStatueStage: 1 }],
          machines: [],
          subscriptions: [],
          goals: [],
          agents: [
            {
              id: 'agent-dev-1',
              name: 'Имхотеп',
              kind: 'worker',
              roleKey: 'DEV-ENG',
              roleClass: 'executor',
              archetype: 'builder',
              isTurnkey: false,
              departmentId: 'dept-dev',
              machineId: null,
              subscriptionId: null,
              provider: 'claude',
              model: 'claude-opus-5-5',
              acceptedTasks: 44,
              level: 6,
              nextLevelRemaining: 6,
              houseStage: 4,
              liveState: 'working',
              currentTask: { id: 'task-1', number: 1803, title: 'Построить гавань' },
            },
          ],
          orchestrator: null,
          relocations: [],
          permissions: { canRelocateAny: true, relocatableDepartmentIds: ['dept-dev'] },
        },
      }),
    );
    await page.route('**/api/agents/agent-dev-1', route =>
      route.fulfill({
        json: {
          id: 'agent-dev-1',
          kind: 'worker',
          name: 'Имхотеп',
          role: { id: 'DEV-ENG', title: { en: 'Developer', ru: 'Разработчик' } },
          department: { id: 'dept-dev', name: 'Development' },
          product: null,
          team: null,
          teams: [],
          model: 'claude-opus-5-5',
          effort: 'high',
          subscription: null,
          machine: null,
          state: 'working',
          currentTask: { id: 'task-1', number: 1803, title: 'Построить гавань' },
          inboxUnread: 1,
          program: null,
          alarm: null,
          retry: null,
          failure: null,
          skills: [],
          parts: [],
          raw: '',
          runsOn: [],
          changes: [],
          interrupted: [],
          canEdit: true,
          canRemove: false,
          timer: null,
        },
      }),
    );
    await page.route('**/api/agents/agent-dev-1/messages', route => {
      const body = route.request().postDataJSON() as { text?: string };
      if (body.text) posted.push(body.text);
      return route.fulfill({ status: 201, json: { ok: true } });
    });
    await page.route('**/api/agents/agent-dev-1/events*', route =>
      route.fulfill({
        json: {
          events: [
            { seq: 1, kind: 'text', at: '2026-11-22T10:00:00.000Z', data: { text: 'Да, повелитель, я возвожу стены у реки.' } },
            ...posted.flatMap((msg, idx) => [
              { seq: 2 + idx * 2, kind: 'message', at: '2026-11-22T10:01:00.000Z', person: { id: ME.person.id, name: ME.person.name }, data: { text: msg } },
              { seq: 3 + idx * 2, kind: 'text', at: '2026-11-22T10:01:02.000Z', data: { text: `Да, повелитель, я исполню вашу просьбу: "${msg}".` } },
            ]),
          ],
          state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0, terminal: true },
        },
      }),
    );

    await page.goto('/');
    await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
    await page.waitForFunction(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__?: { getResidents: () => unknown[] } }).__WORLD_PRODUCT__;
      return Boolean(h && h.getResidents().length > 0);
    });

    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__: { selectResidentByRoleClass: (r?: string) => unknown } }).__WORLD_PRODUCT__;
      h.selectResidentByRoleClass('executor');
    });

    const win = page.locator('.orch').first();
    await expect(win).toBeVisible();
    await expect(win.getByTestId('world-agent-level-strip')).toContainText('Уровень 6');
    await expect(win.locator('.t-log.chat')).toContainText('Да, повелитель, я возвожу стены у реки.');
    await expect(page.getByTestId('world-agent-quick-chat')).toHaveCount(0);

    await win.locator('textarea').fill('Подготовь отчет по стройке у реки');
    await win.locator('.chat-send').click();
    await expect(win.locator('.t-log.chat')).toContainText('Да, повелитель, я исполню вашу просьбу');

    const egyptChatPath = info.outputPath('stage7-agent-window-egypt.png');
    await page.screenshot({ path: egyptChatPath, animations: 'disabled' });
    exportShot(egyptChatPath, 'stage7-agent-window-egypt.png');
  });
});
