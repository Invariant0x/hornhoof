import { mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import type { BuiltinSkinId } from '../src/skins/registry';
import type { EventView, Org } from '../src/types';
import { CARD, SUB } from './agent-window-api';
import { ME, serveApi } from './api';

type ThemeChoice = Extract<BuiltinSkinId, 'cyberpunk' | 'light' | 'egypt'>;
type Lang = 'en' | 'ru';

const DEV_ID = '00000000-0000-4000-8000-000000000002';
const BRUNO_ID = 'agent-dev-1';
const ORCH_PARTY = { kind: 'agent' as const, id: 'a1', name: 'Orchestrator', role: null, department: null, agentKind: 'orchestrator' as const };
const BRUNO_PARTY = { kind: 'agent' as const, id: BRUNO_ID, name: 'Bruno', role: { en: 'Developer', ru: 'Разработчик' }, department: { id: DEV_ID, name: { en: 'Development', ru: 'Разработка' } }, agentKind: 'worker' as const };
const PERSON_PARTY = { kind: 'person' as const, id: ME.person.id, name: ME.person.name, role: { en: 'CEO', ru: 'CEO' }, department: null };

function saveShot(src: string, name: string): void {
  const dir = process.env.HH_CHAT_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  copyFileSync(src, join(dir, name));
}

function buildOrg(theme: ThemeChoice): Org {
  return {
    company: { ...ME.company, theme },
    orchestrator: {
      id: 'a1',
      name: 'Orchestrator',
      model: 'claude-opus-4-6',
      effort: 'high',
      subscription: SUB,
      context: 0.24,
      program: null,
      alarm: null,
      retry: null,
      failure: null,
    },
    agents: { total: 2, working: 0 },
    people: [],
    departments: [
      {
        id: DEV_ID,
        name: 'Development',
        templateKey: 'development',
        roleCode: 'DEV',
        about: '',
        agents: { total: 1, working: 0 },
        products: [],
        teams: [],
        people: [],
        employees: [
          {
            id: BRUNO_ID,
            name: 'Bruno',
            roleId: 'DEV-ENG',
            title: { en: 'Developer', ru: 'Разработчик' },
            kind: 'worker',
            model: 'gpt-5.4',
            modelName: 'GPT-5.4',
            provider: 'codex',
            effort: 'high',
            state: 'sleeping',
            status: 'idle',
            on: true,
            timer: null,
            task: {
              id: 't-2046',
              number: 2046,
              title: 'Chat replies and message numbers',
              echelons: {
                kind: 'development_echelons',
                version: 1,
                resultKind: 'turnkey',
                phase: 'active',
                stage: null,
                ownerAgentId: BRUNO_ID,
                candidateId: null,
                revision: 1,
                stages: [],
                abilities: {},
                security: { required: false, reason: null, addedBy: null },
                assignment: null,
              },
            },
            context: 0.31,
            program: null,
            alarm: null,
            retry: null,
            failure: null,
          },
        ],
        roles: [{ id: 'DEV-ENG', title: { en: 'Developer', ru: 'Разработчик' }, description: { en: 'Builds features', ru: 'Строит функции' }, kind: 'member', gate: null }],
      },
    ],
  };
}

function makeConversation(longText = false): EventView[] {
  const longQuestion = longText
    ? 'Please confirm the exact migration rollback window for /srv/deployments/eu-central-1/hornhoof-cluster-primary/release-2046-candidate-verification-manifest.json and whether internationalized identifiers like ПодтверждениеРазвертыванияБезОбрезкиСтрокИМноготочия wrap cleanly across narrow viewports.'
    : 'Which release window should we use for the checkout cutover, Friday night or Monday morning?';
  return [
    {
      seq: 1,
      number: 1,
      kind: 'message',
      at: '2026-11-24T10:00:00.000Z',
      jobId: 'j-1',
      person: { id: ME.person.id, name: ME.person.name },
      data: { text: 'Kick off the checkout cutover preparation.' },
      message: { direction: 'in', from: PERSON_PARTY, to: BRUNO_PARTY },
    } as EventView,
    {
      seq: 2,
      number: 2,
      kind: 'text',
      at: '2026-11-24T10:01:00.000Z',
      jobId: 'j-1',
      person: null,
      task: { id: 't-2046', number: 2046 },
      data: { text: longQuestion },
    } as EventView,
    {
      seq: 3,
      number: 3,
      kind: 'message',
      at: '2026-11-24T10:02:00.000Z',
      jobId: 'j-2',
      person: { id: ME.person.id, name: ME.person.name },
      task: { id: 't-2046', number: 2046 },
      data: { text: 'Monday morning at 07:00 UTC works best for the team.' },
      message: { direction: 'in', from: PERSON_PARTY, to: BRUNO_PARTY },
      replyTo: {
        number: 2,
        seq: 2,
        sender: BRUNO_PARTY,
        excerpt: longQuestion.slice(0, 180),
        task: { id: 't-2046', number: 2046 },
      },
    } as EventView,
  ];
}

async function openChatWindow(
  page: Page,
  opts: { theme: ThemeChoice; lang: Lang; width: 1440 | 375; rtl?: boolean; longText?: boolean; pagedHistory?: boolean },
) {
  const errors: string[] = [];
  page.on('pageerror', err => errors.push(err.message));
  page.on('console', msg => {
    if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) errors.push(msg.text());
  });
  await page.setViewportSize({ width: opts.width, height: opts.width === 1440 ? 900 : 812 });
  await page.addInitScript(({ lang, theme }) => {
    localStorage.setItem('hh-lang', lang);
    localStorage.setItem('hh-theme', theme);
    localStorage.setItem('hh-agent-view', 'chat');
  }, { lang: opts.lang, theme: opts.theme });

  const olderEvents: EventView[] = opts.pagedHistory
    ? [
        {
          seq: 1,
          number: 1,
          kind: 'text',
          at: '2026-11-20T09:00:00.000Z',
          jobId: 'j-0',
          person: null,
          data: { text: 'Earliest milestone note stored on an older page.' },
        } as EventView,
      ]
    : [];
  const currentEvents: EventView[] = opts.pagedHistory
    ? Array.from({ length: 300 }, (_, i) => {
        const seq = i + 10;
        const n = i + 2;
        if (i === 299) {
          return {
            seq,
            number: n,
            kind: 'message',
            at: '2026-11-24T10:05:00.000Z',
            jobId: 'j-last',
            person: { id: ME.person.id, name: ME.person.name },
            data: { text: 'Following up on the earliest milestone.' },
            message: { direction: 'in', from: PERSON_PARTY, to: ORCH_PARTY },
            replyTo: {
              number: 1,
              seq: 1,
              sender: ORCH_PARTY,
              excerpt: 'Earliest milestone note stored on an older page.',
            },
          } as EventView;
        }
        return {
          seq,
          number: n,
          kind: 'text',
          at: '2026-11-24T09:30:00.000Z',
          jobId: 'j-mid',
          person: null,
          data: { text: `Progress update line ${n}.` },
        } as EventView;
      })
    : makeConversation(Boolean(opts.longText));

  const posted: Array<{ text: string; replyTo?: number }> = [];

  await serveApi(page);
  await page.route('**/api/me', route => route.fulfill({ json: { ...ME, company: { ...ME.company, theme: opts.theme } } }));
  await page.route('**/api/org', route => route.fulfill({ json: buildOrg(opts.theme) }));
  await page.route('**/api/world/state', route =>
    route.fulfill({
      json: {
        companyId: ME.company.id,
        companyName: ME.company.name,
        departments: [{ id: DEV_ID, name: 'Development', templateKey: 'development', roleCode: 'DEV', totalAgents: 1, workingAgents: 0 }],
        agents: [{ id: BRUNO_ID, name: 'Bruno', kind: 'worker', departmentId: DEV_ID, state: 'sleeping', status: 'idle', acceptedTasks: 12, level: 4, provider: 'codex' }],
        subscriptions: [{ id: SUB.id, provider: 'claude', label: SUB.label, status: 'ready', online: true }],
        goals: [],
        pulses: [],
      },
    }),
  );
  await page.route('**/api/agents/orchestrator', route =>
    route.fulfill({ json: { ...CARD, id: 'a1', kind: 'orchestrator', name: 'Orchestrator', role: null, department: null, currentTask: null } }),
  );
  await page.route('**/api/agents/orchestrator/start', route => route.fulfill({ json: { started: false } }));
  await page.route('**/api/agents/orchestrator/messages', async route => {
    const body = route.request().postDataJSON() as { text: string; replyTo?: number };
    posted.push(body);
    const nextSeq = (currentEvents.at(-1)?.seq ?? 10) + 1;
    const nextNum = ((currentEvents.at(-1) as { number?: number } | undefined)?.number ?? currentEvents.length) + 1;
    const target = [...olderEvents, ...currentEvents].find(e => (e as { number?: number }).number === body.replyTo);
    currentEvents.push({
      seq: nextSeq,
      number: nextNum,
      kind: 'message',
      at: '2026-11-24T10:06:00.000Z',
      jobId: 'j-new',
      person: { id: ME.person.id, name: ME.person.name },
      data: { text: body.text },
      message: { direction: 'in', from: PERSON_PARTY, to: ORCH_PARTY },
      ...(target
        ? {
            replyTo: {
              number: body.replyTo!,
              seq: target.seq,
              sender: target.kind === 'text' ? BRUNO_PARTY : PERSON_PARTY,
              excerpt: String((target.data as { text?: string }).text ?? '').slice(0, 180),
            },
          }
        : {}),
    } as EventView);
    await route.fulfill({ status: 202, json: { jobId: 'j-new' } });
  });
  await page.route('**/api/agents/orchestrator/events*', async route => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get('before');
    const after = url.searchParams.get('after');
    if (before) {
      const b = Number(before);
      const slice = [...olderEvents, ...currentEvents].filter(e => e.seq < b).slice(-200);
      await route.fulfill({ json: { events: slice, state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } } });
      return;
    }
    if (after !== null) {
      const a = Number(after);
      await route.fulfill({ json: { events: currentEvents.filter(e => e.seq > a), state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } } });
      return;
    }
    await route.fulfill({ json: { events: currentEvents.slice(-300), state: { ready: true, reason: null, busy: false, runningJobId: null, queued: 0 } } });
  });

  await page.goto('/');
  if (opts.rtl) {
    await page.evaluate(() => {
      document.documentElement.setAttribute('dir', 'rtl');
    });
  }
  if (opts.theme === 'egypt') {
    await expect(page.locator('[data-world-canvas="egypt"]')).toBeVisible();
    await page.waitForFunction(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__?: { getBuildings: () => unknown[] } }).__WORLD_PRODUCT__;
      return Boolean(h && h.getBuildings().length > 0);
    });
    await page.evaluate(() => {
      const h = (window as unknown as { __WORLD_PRODUCT__: { selectBuildingByKind: (kind: string, idx?: number) => unknown } }).__WORLD_PRODUCT__;
      h.selectBuildingByKind('residence', 0);
    });
  } else {
    await page.locator('button.hub').click();
  }
  const win = page.locator('.orch').first();
  await expect(win).toBeVisible();
  await expect(win.getByRole('log')).toBeVisible();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return { win, posted, errors };
}

test.describe('chat reply with quote, stable numbers, jump & highlight, and theme geometry', () => {
  test('replies with quote, cancels on Esc, persists across reload, and jumps across unloaded pages to highlight original', async ({ page }) => {
    const { win, posted, errors } = await openChatWindow(page, { theme: 'cyberpunk', lang: 'en', width: 1440, pagedHistory: true });
    const latest = win.locator('article.chat-msg').last();
    await expect(latest).toContainText('#301');

    /* Jump to #1 which is outside the initial 300-event page: loads older history, scrolls to #1, and highlights it. */
    await latest.getByRole('button', { name: /#1/ }).click();
    const first = win.locator('article.chat-msg[data-msg-number="1"]');
    await expect(first).toBeVisible();
    await expect(first).toHaveClass(/highlighted/);

    /* Right-click starts reply, Escape cancels it cleanly. */
    await first.click({ button: 'right' });
    await expect(win.getByTestId('chat-reply-preview')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(win.getByTestId('chat-reply-preview')).toHaveCount(0);

    /* Hover reply button sends a new reply with replyTo: 1, and numbers remain stable after reload. */
    await first.hover();
    const replyBtn = first.getByRole('button', { name: en.window.chat.replyTo(1) });
    await page.keyboard.press('Tab');
    await replyBtn.focus();
    const outline = await replyBtn.evaluate(el => getComputedStyle(el).outlineStyle);
    expect(outline).toBe('solid');
    await replyBtn.click();
    await expect(win.getByTestId('chat-reply-preview')).toContainText('#1');

    await win.locator('textarea').fill('Confirmed on the first milestone.');
    await win.locator('.chat-send').click();
    await expect.poll(() => posted.length).toBe(1);
    expect(posted[0]).toEqual({ text: 'Confirmed on the first milestone.', replyTo: 1 });
    await expect(win.locator('article.chat-msg[data-msg-number="302"]')).toContainText('Confirmed on the first milestone.');

    await page.reload();
    if ((await page.locator('.orch').count()) === 0) await page.locator('button.hub').click();
    await expect(page.locator('.orch article.chat-msg[data-msg-number="302"]')).toContainText('#302');
    expect(errors).toEqual([]);
  });

  const matrix: Array<{ name: string; theme: ThemeChoice; lang: Lang; width: 1440 | 375; rtl?: boolean; longText?: boolean }> = [
    { name: 'cyberpunk-dark-en-1440', theme: 'cyberpunk', lang: 'en', width: 1440 },
    { name: 'cyberpunk-dark-ru-375', theme: 'cyberpunk', lang: 'ru', width: 375 },
    { name: 'light-en-1440', theme: 'light', lang: 'en', width: 1440 },
    { name: 'light-ru-375', theme: 'light', lang: 'ru', width: 375 },
    { name: 'egypt-en-1440', theme: 'egypt', lang: 'en', width: 1440 },
    { name: 'egypt-ru-375', theme: 'egypt', lang: 'ru', width: 375 },
    { name: 'cyberpunk-rtl-1440', theme: 'cyberpunk', lang: 'en', width: 1440, rtl: true },
    { name: 'egypt-longtext-375', theme: 'egypt', lang: 'ru', width: 375, longText: true },
  ];

  for (const c of matrix) {
    test(`renders theme tokens without overflow, ellipsis or Telegram branding: ${c.name}`, async ({ page }, info: TestInfo) => {
      const t = c.lang === 'en' ? en : ru;
      const { win, errors } = await openChatWindow(page, c);

      const msg2 = win.locator('article.chat-msg[data-msg-number="2"]');
      await expect(msg2).toBeVisible();
      await expect(msg2).toContainText('#2');
      await expect(msg2).toContainText('#2046');

      /* Open composer quote preview so both inline quote and composer quote are visible in the shot & geometry check. */
      await msg2.click({ button: 'right' });
      await expect(win.getByTestId('chat-reply-preview')).toBeVisible();

      if (c.name === 'cyberpunk-dark-en-1440') {
        const taskBtn = msg2.locator('button.chat-task-btn');
        const replyBtn = msg2.getByRole('button', { name: t.window.chat.replyTo(2) });
        await taskBtn.focus();
        /* Navigate via keyboard Tab so real :focus-visible outline (--cyan-ink) shows on Reply to #2. */
        await page.keyboard.press('Tab');
        await expect(replyBtn).toBeFocused();
        expect(await replyBtn.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid');
        const focusPath = info.outputPath('chat-reply-focus-ring-cyberpunk-1440.png');
        await win.screenshot({ path: focusPath, animations: 'disabled' });
        saveShot(focusPath, 'chat-reply-focus-ring-cyberpunk-1440.png');
      }

      /* Verify zero horizontal overflow inside chat log, message bubbles, quotes, and composer, and zero Telegram brand text. */
      const check = await win.evaluate(el => {
        const log = el.querySelector<HTMLElement>('.t-log.chat')!;
        const composer = el.querySelector<HTMLElement>('.chat-in')!;
        const quotes = [...el.querySelectorAll<HTMLElement>('.chat-quote, .chat-reply-bar')];
        const ellipsis = quotes.some(q => getComputedStyle(q).textOverflow === 'ellipsis');
        return {
          logOverflow: log.scrollWidth - log.clientWidth,
          composerOverflow: composer.scrollWidth - composer.clientWidth,
          ellipsis,
          text: el.textContent ?? '',
        };
      });
      expect(check.logOverflow).toBeLessThanOrEqual(1);
      expect(check.composerOverflow).toBeLessThanOrEqual(1);
      expect(check.ellipsis).toBe(false);
      expect(check.text.toLowerCase()).not.toContain('telegram');

      const shotName = `chat-reply-${c.name}.png`;
      const shotPath = info.outputPath(shotName);
      await page.screenshot({ path: shotPath, animations: 'disabled' });
      saveShot(shotPath, shotName);
      expect(errors).toEqual([]);
    });
  }
});
