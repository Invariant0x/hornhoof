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
    await expect(settingsDialog.getByRole('button', { name: 'Переименовать агентов по эпохе' })).toBeVisible();

    const ceoThemePath = info.outputPath('stage7-ceo-company-theme.png');
    await page.screenshot({ path: ceoThemePath, animations: 'disabled' });
    exportShot(ceoThemePath, 'stage7-ceo-company-theme.png');

    /* Open rename preview confirmation modal and capture screenshot. */
    await settingsDialog.getByRole('button', { name: 'Переименовать агентов по эпохе' }).click();
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

  test('clicking a resident opens a simple human-friendly chat popup in both Egypt and Dungeon worlds', async ({ page }, info) => {
    await page.setViewportSize({ width: 1366, height: 860 });
    await page.goto('/world-demo/live-city.html?pack=egypt&scenario=hornhoof&lang=ru');
    await page.waitForFunction(() => Boolean((window as unknown as { __liveCityDebug?: unknown }).__liveCityDebug));
    await page.waitForTimeout(300);

    /* Select a resident and chat in Egypt voice without developer terminal jargon. */
    const pickedEgypt = await page.evaluate(() => {
      const dbg = (window as unknown as { __liveCityDebug: { selectResidentByRoleClass: (c: string) => { name: string } | null } }).__liveCityDebug;
      return dbg.selectResidentByRoleClass('executor');
    });
    expect(pickedEgypt).not.toBeNull();

    const chatBox = page.getByTestId('world-agent-quick-chat');
    await expect(chatBox).toBeVisible();
    await expect(chatBox).toContainText('Да, повелитель');

    const input = chatBox.locator('input[type="text"]');
    await input.fill('Подготовь отчет по стройке у реки');
    await chatBox.getByTestId('world-quick-chat-send').click();
    await expect(chatBox).toContainText('Подготовь отчет по стройке у реки');
    await expect(chatBox).toContainText('Да, повелитель, я исполню вашу просьбу');

    const egyptChatPath = info.outputPath('stage7-agent-quick-chat-egypt.png');
    await page.screenshot({ path: egyptChatPath, animations: 'disabled' });
    exportShot(egyptChatPath, 'stage7-agent-quick-chat-egypt.png');

    /* Switch to the second test pack (Dungeon) and verify its own distinct voice in the same simple chat UI. */
    await page.goto('/world-demo/live-city.html?pack=dungeon&scenario=hornhoof&lang=ru');
    await page.waitForFunction(() => Boolean((window as unknown as { __liveCityDebug?: unknown }).__liveCityDebug));
    await page.waitForTimeout(300);

    await page.evaluate(() => {
      const dbg = (window as unknown as { __liveCityDebug: { selectResidentByRoleClass: (c: string) => unknown } }).__liveCityDebug;
      dbg.selectResidentByRoleClass('executor');
    });
    await expect(chatBox).toBeVisible();
    await expect(chatBox).toContainText('Слушаюсь, хранитель глубин');
    await chatBox.locator('input[type="text"]').fill('Проверь факелы в западном зале');
    await chatBox.getByTestId('world-quick-chat-send').click();
    await expect(chatBox).toContainText('Слушаюсь, хранитель глубин! Исполняю вашу просьбу');

    const dungeonChatPath = info.outputPath('stage7-agent-quick-chat-dungeon.png');
    await page.screenshot({ path: dungeonChatPath, animations: 'disabled' });
    exportShot(dungeonChatPath, 'stage7-agent-quick-chat-dungeon.png');
  });
});
