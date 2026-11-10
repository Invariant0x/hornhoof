import { expect, test, type Page } from '@playwright/test';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';

/* Render real native scrollbars in headless Chromium so .xterm-viewport has a visible scrollbar track and thumb. */
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

type SizeReport = { cols: number; rows: number; via: 'open' | 'resize' };

function rulerLine(cols: number, row: number): string {
  const digits = '1234567890';
  if (cols < 6) return 'X'.repeat(Math.max(0, cols - 1)) + 'Z';
  const suffix = `${String(cols).padStart(3, '0')}Z`;
  const prefixTag = `R${String(row).padStart(2, '0')}:`;
  const bodyLen = Math.max(0, cols - prefixTag.length - suffix.length);
  let body = '';
  while (body.length < bodyLen) body += digits;
  return (prefixTag + body.slice(0, bodyLen) + suffix).slice(-cols);
}

function fullScreenPayload(cols: number, lineCount = 90): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i++) lines.push(rulerLine(cols, i));
  return `\x1bc${lines.join('\r\n')}`;
}

async function openMeasuredTerminal(page: Page, width: number, height: number, theme: 'light' | 'dark' = 'dark') {
  await page.setViewportSize({ width, height });
  await page.addInitScript(selectedTheme => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', selectedTheme);
  }, theme);

  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });

  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0 };
  await serveAgentWindow(page, live);

  const reported: SizeReport[] = [];
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    live.connections++;
    const reqUrl = new URL(ws.url());
    const initialCols = Number(reqUrl.searchParams.get('cols') ?? 80);
    const initialRows = Number(reqUrl.searchParams.get('rows') ?? 24);
    reported.push({ cols: initialCols, rows: initialRows, via: 'open' });

    ws.send(JSON.stringify({ type: 'ready', write: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: fullScreenPayload(initialCols) }));

    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw)) as { type: string; cols?: number; rows?: number };
      if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        reported.push({ cols: msg.cols, rows: msg.rows, via: 'resize' });
        ws.send(JSON.stringify({ type: 'data', data: fullScreenPayload(msg.cols) }));
      }
    });
  });

  await page.goto('/');
  await page.getByRole('button', { name: /Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();

  const agentWindow = page.getByRole('complementary', { name: /^Bruno,/ });
  await expect(agentWindow).toBeVisible();
  await expect(agentWindow.locator('.xterm-screen')).toBeVisible();

  return { agentWindow, reported, errors };
}

async function verifyLastColumnVisible(page: Page, reported: SizeReport[]) {
  await expect.poll(async () => {
    const latest = reported.at(-1);
    if (!latest) return false;
    return page.evaluate(expectedCols => {
      const xterm = document.querySelector<HTMLElement>('.t-term .xterm');
      const viewport = document.querySelector<HTMLElement>('.t-term .xterm-viewport');
      const scrollArea = document.querySelector<HTMLElement>('.t-term .xterm-scroll-area');
      const screen = document.querySelector<HTMLElement>('.t-term .xterm-screen');
      if (!xterm || !viewport || !scrollArea || !screen) return false;
      const vpRect = viewport.getBoundingClientRect();
      const saRect = scrollArea.getBoundingClientRect();
      const screenRect = screen.getBoundingClientRect();
      const scrollbarWidth = Math.max(vpRect.width - saRect.width, viewport.offsetWidth - viewport.clientWidth);
      const paddingRight = parseFloat(getComputedStyle(xterm).paddingRight);
      const rows = [...document.querySelectorAll<HTMLElement>('.t-term .xterm-rows > div')];
      const nonEmpty = rows.filter(r => (r.textContent ?? '').length > 0);
      if (nonEmpty.length < 5) return false;
      const firstText = nonEmpty[0]!.firstChild?.firstChild;
      if (!firstText || firstText.nodeType !== Node.TEXT_NODE || (firstText.textContent?.length ?? 0) === 0) return false;
      const charRange = document.createRange();
      charRange.setStart(firstText, 0);
      charRange.setEnd(firstText, 1);
      const charWidth = charRange.getBoundingClientRect().width;
      if (charWidth <= 0 || Math.abs(screenRect.width - expectedCols * charWidth) > 2) return false;
      const rightSlack = vpRect.right - scrollbarWidth - paddingRight - screenRect.right;
      if (rightSlack < -0.5 || rightSlack > charWidth + 1.5) return false;
      const suffix = `${String(expectedCols).padStart(3, '0')}Z`;
      return nonEmpty.every(r => {
        const text = r.textContent ?? '';
        return text.length === expectedCols && text.endsWith(suffix);
      });
    }, latest.cols);
  }).toBe(true);

  const expectedCols = reported.at(-1)!.cols;
  const metrics = await page.evaluate(cols => {
    const term = document.querySelector<HTMLElement>('.t-term')!;
    const xterm = term.querySelector<HTMLElement>('.xterm')!;
    const viewport = term.querySelector<HTMLElement>('.xterm-viewport')!;
    const scrollArea = term.querySelector<HTMLElement>('.xterm-scroll-area')!;
    const screen = term.querySelector<HTMLElement>('.xterm-screen')!;
    const rows = [...term.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter(r => (r.textContent ?? '').length > 0);

    const vpRect = viewport.getBoundingClientRect();
    const saRect = scrollArea.getBoundingClientRect();
    const screenRect = screen.getBoundingClientRect();
    const termRect = term.getBoundingClientRect();
    const scrollbarWidth = Math.max(vpRect.width - saRect.width, viewport.offsetWidth - viewport.clientWidth);
    const scrollbarLeft = vpRect.right - scrollbarWidth;

    const sampleRow = rows[Math.min(4, rows.length - 1)]!;
    const rowRect = sampleRow.getBoundingClientRect();
    const walker = document.createTreeWalker(sampleRow, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    while (walker.nextNode()) lastText = walker.currentNode as Text;
    const range = document.createRange();
    const textLen = lastText?.data.length ?? 0;
    if (lastText && textLen > 0) {
      range.setStart(lastText, textLen - 1);
      range.setEnd(lastText, textLen);
    }
    const lastCharRect = range.getBoundingClientRect();
    const hit = document.elementFromPoint(
      lastCharRect.right - Math.min(1, lastCharRect.width / 4),
      (lastCharRect.top + lastCharRect.bottom) / 2,
    );

    return {
      colorScheme: getComputedStyle(term).colorScheme,
      paddingRight: parseFloat(getComputedStyle(xterm).paddingRight),
      scrollbarWidth,
      scrollable: viewport.scrollHeight > viewport.clientHeight,
      scrollbarLeft,
      screenRight: screenRect.right,
      termRight: termRect.right,
      rowRight: rowRect.right,
      rowLengths: rows.slice(0, 8).map(r => (r.textContent ?? '').length),
      lastChars: rows.slice(0, 8).map(r => (r.textContent ?? '').slice(-4)),
      lastCharWidth: lastCharRect.width,
      lastCharRight: lastCharRect.right,
      hitInsideScreen: Boolean(hit && screen.contains(hit)),
      expectedSuffix: `${String(cols).padStart(3, '0')}Z`,
    };
  }, expectedCols);

  expect(metrics.scrollbarWidth).toBeGreaterThanOrEqual(14);
  expect(metrics.scrollable).toBe(true);
  expect(metrics.rowLengths).toEqual(metrics.rowLengths.map(() => expectedCols));
  expect(metrics.lastChars).toEqual(metrics.lastChars.map(() => metrics.expectedSuffix));
  expect(metrics.lastCharWidth).toBeGreaterThan(4);
  expect(metrics.screenRight).toBeLessThanOrEqual(metrics.scrollbarLeft - metrics.paddingRight + 0.5);
  expect(metrics.lastCharRight).toBeLessThanOrEqual(metrics.rowRight + 0.05);
  expect(metrics.lastCharRight).toBeLessThanOrEqual(metrics.scrollbarLeft - metrics.paddingRight + 0.5);
  expect(metrics.lastCharRight).toBeLessThanOrEqual(metrics.termRight - metrics.scrollbarWidth);
  expect(metrics.hitInsideScreen).toBe(true);
  expect(metrics.colorScheme).toBe('dark');
  expect(metrics.paddingRight).toBeGreaterThanOrEqual(8);
  return { expectedCols, metrics };
}

test.describe('agent terminal full-width column visibility and node resize parity', () => {
  test('narrow (375px), regular (1024px) and wide (1440px) windows keep every column visible before a live scrollbar', async ({ page }, info) => {
    const { agentWindow, reported, errors } = await openMeasuredTerminal(page, 375, 812, 'dark');

    /* 1. Narrow 375px window with visible scrollbar. */
    const narrow = await verifyLastColumnVisible(page, reported);
    expect(narrow.expectedCols).toBeGreaterThan(35);
    await page.screenshot({ path: info.outputPath('terminal-375px-narrow.png') });

    /* 2. Regular 1024px desktop window: resize must send updated visible cols and keep last char clear of scrollbar. */
    await page.setViewportSize({ width: 1024, height: 768 });
    const regular = await verifyLastColumnVisible(page, reported);
    expect(regular.expectedCols).toBeGreaterThan(narrow.expectedCols);
    await page.screenshot({ path: info.outputPath('terminal-1024px-regular.png') });

    /* 3. Wide 1440px fullscreen window: fills 1440px width and sends exact fullscreen visible cols. */
    await page.setViewportSize({ width: 1440, height: 900 });
    await agentWindow.getByRole('button', { name: 'Full screen', exact: true }).click();
    const wide = await verifyLastColumnVisible(page, reported);
    expect(wide.expectedCols).toBeGreaterThan(regular.expectedCols);
    await page.screenshot({ path: info.outputPath('terminal-1440px-wide.png') });

    /* 4. Dynamic scrollbar widening after open (e.g. browser zoom or OS scrollbar switch to 24px):
       terminal refits immediately, notifies the node via resize, and never lets the scrollbar overlap column cols. */
    await page.addStyleTag({
      content: '.t-term .xterm-viewport::-webkit-scrollbar { width: 24px; } .t-term .xterm-viewport::-webkit-scrollbar-thumb { background: #5a6572; }',
    });
    const widened = await verifyLastColumnVisible(page, reported);
    expect(widened.metrics.scrollbarWidth).toBeGreaterThanOrEqual(23);
    expect(widened.expectedCols).toBeLessThan(wide.expectedCols);

    expect(errors).toEqual([]);
  });

  test('never overlaps the last column on a light page or when a thin resting scrollbar expands across 375px, 1024px and 1440px', async ({ page }) => {
    /* Simulate platforms where the resting scrollbar at term.open() is thin (6px), then widens to 22px when active. */
    await page.addInitScript(() => {
      const style = document.createElement('style');
      style.id = 'scrollbar-probe';
      style.textContent = '.t-term .xterm-viewport::-webkit-scrollbar { width: 6px; }';
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
    });
    const { agentWindow, reported, errors } = await openMeasuredTerminal(page, 375, 812, 'light');

    /* Expand scrollbar to 22px active track without changing outer window size first. */
    await page.evaluate(() => {
      document.getElementById('scrollbar-probe')!.textContent =
        '.t-term .xterm-viewport::-webkit-scrollbar { width: 22px; } .t-term .xterm-viewport::-webkit-scrollbar-thumb { background: #5a6572; }';
    });

    const narrow = await verifyLastColumnVisible(page, reported);
    expect(narrow.metrics.scrollbarWidth).toBeGreaterThanOrEqual(21);

    await page.setViewportSize({ width: 1024, height: 768 });
    const regular = await verifyLastColumnVisible(page, reported);
    expect(regular.expectedCols).toBeGreaterThan(narrow.expectedCols);

    await page.setViewportSize({ width: 1440, height: 900 });
    await agentWindow.getByRole('button', { name: 'Full screen', exact: true }).click();
    const wide = await verifyLastColumnVisible(page, reported);
    expect(wide.expectedCols).toBeGreaterThan(regular.expectedCols);
    expect(errors).toEqual([]);
  });
});
