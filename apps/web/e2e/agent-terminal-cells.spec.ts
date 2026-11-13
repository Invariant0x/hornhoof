import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { serveAgentWindow, type AgentFixture } from './agent-window-api';
import { chooseTerminal } from './api';

/* The terminal's fonts come from the test, so every machine lays out the same advances: DejaVu Sans Mono, which the server
   bundles, at its own width of 1233/2048 of the size (Menlo and DejaVu Sans Mono) and narrowed to Monaco's 1229/2048.
   Each case gives that face to every named family of the terminal's list, so no font of the machine takes its place. */
const FONTS = new URL('../../server/src/modules/program-operator/fonts/', import.meta.url);
const REGULAR = readFileSync(new URL('DejaVuSansMono.ttf', FONTS)).toString('base64');
const BOLD = readFileSync(new URL('DejaVuSansMono-Bold.ttf', FONTS)).toString('base64');
const CASES = [
  { font: 'Monaco', sizeAdjust: `${(1229 / 1233) * 100}%` },
  { font: 'Menlo and DejaVu Sans Mono', sizeAdjust: '100%' },
];
const NARROW = 375;
const WIDE = 1440;
const STATUS = 'Gemini 4 Carbon · high';
/* Where a character may stand off its cell: what layout rounds a position to, with room to spare, while a glyph that is a
   hundredth of a pixel wider than its cell is off by more than that within ten columns. */
const GRID_SLACK = 0.1;

type FontCase = (typeof CASES)[number];

/* Chromium on Linux rounds every advance to a whole pixel while it hints glyphs, which no Mac does: unhinted, it lays out
   the font's own fractional advance, as Chrome on a Mac does. */
test.use({ launchOptions: { args: ['--font-render-hinting=none'] } });

/* Full rows of what cuts show on: the status line of the bug, box drawing, digits, W (the glyph xterm measures as it opens)
   regular and bold, and a narrow m. */
function screenLines(cols: number): string[] {
  return [
    STATUS.padStart(cols),
    '─'.repeat(cols),
    '1234567890'.repeat(Math.ceil(cols / 10)).slice(0, cols),
    'W'.repeat(cols),
    `\x1b[1m${'W'.repeat(cols)}\x1b[0m`,
    'm'.repeat(cols),
    `${'─'.repeat(cols - 4)}high`,
  ];
}

const FULL_ROWS = screenLines(STATUS.length).length;

function screenPayload(cols: number): string {
  return `\x1bc${screenLines(cols).join('\r\n')}`;
}

async function giveFonts(page: Page, { sizeAdjust }: FontCase) {
  await page.addInitScript(({ regular, bold, sizeAdjust: adjust }) => {
    const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
    /* Chromium takes sizeAdjust, which the DOM types of TypeScript do not list yet. */
    const face = (weight: string): FontFaceDescriptors & { sizeAdjust: string } => ({ weight, sizeAdjust: adjust });
    for (const family of ['Monaco', 'Menlo', 'DejaVu Sans Mono']) {
      document.fonts.add(new FontFace(family, bytes(regular), face('normal')));
      document.fonts.add(new FontFace(family, bytes(bold), face('bold')));
    }
  }, { regular: REGULAR, bold: BOLD, sizeAdjust });
}

async function openTerminal(page: Page, fontCase: FontCase, width: number) {
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => {
    localStorage.setItem('hh-lang', 'en');
    localStorage.setItem('hh-theme', 'dark');
  });
  await chooseTerminal(page);
  await giveFonts(page, fontCase);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  const live: AgentFixture = { awake: true, hasTask: true, messages: [], connections: 0 };
  await serveAgentWindow(page, live);
  const sizes: number[] = [];
  await page.routeWebSocket('**/api/agents/b1/terminal*', ws => {
    const cols = Number(new URL(ws.url()).searchParams.get('cols') ?? 80);
    sizes.push(cols);
    ws.send(JSON.stringify({ type: 'ready', write: true }));
    ws.send(JSON.stringify({ type: 'program', running: true }));
    ws.send(JSON.stringify({ type: 'data', data: screenPayload(cols) }));
    ws.onMessage(raw => {
      const msg = JSON.parse(String(raw)) as { type: string; cols?: number };
      if (msg.type !== 'resize' || typeof msg.cols !== 'number') return;
      sizes.push(msg.cols);
      ws.send(JSON.stringify({ type: 'data', data: screenPayload(msg.cols) }));
    });
  });
  await page.goto('/');
  /* The terminal measures its font as it opens, so the faces are in place before it does. */
  await expect.poll(() => page.evaluate(async () => {
    await document.fonts.ready;
    return ['Monaco', 'Menlo', 'DejaVu Sans Mono'].every(family => document.fonts.check(`12px "${family}"`) && document.fonts.check(`bold 12px "${family}"`));
  })).toBe(true);
  await page.getByRole('button', { name: /^Development/ }).click();
  await page.getByRole('region', { name: 'Members' }).getByRole('button', { name: /Bruno/ }).click();
  const agentWindow = page.getByRole('complementary', { name: /^Bruno,/ });
  await expect(agentWindow.locator('.xterm-screen')).toBeVisible();
  return { agentWindow, sizes, errors };
}

type CellReport = { cols: number; cell: number; screen: { top: number; right: number; height: number }; problems: string[] };

/* Every character of every full row against the terminal's own cell grid: its left edge where its column starts, and the
   last one ending inside the screen. */
function measureCells(page: Page, cols: number, slack: number): Promise<CellReport | null> {
  return page.evaluate(({ cols, slack, status, fullRows }) => {
    const screen = document.querySelector<HTMLElement>('.t-term .xterm-screen');
    if (!screen) return null;
    const rows = [...screen.querySelectorAll<HTMLElement>('.xterm-rows > div')].filter(row => (row.textContent ?? '').trim().length > 0);
    if (rows.length !== fullRows || !rows.every(row => row.textContent!.length === cols) || !rows[0]!.textContent!.endsWith(status)) return null;
    const box = screen.getBoundingClientRect();
    const cell = box.width / cols;
    const problems: string[] = [];
    rows.forEach((row, line) => {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let column = 0;
      let right = 0;
      /* The first character off its cell in a row says the most; the rest of that row only repeats it. */
      let off = false;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (let at = 0; at < node.data.length; at++, column++) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + 1);
          const rect = range.getBoundingClientRect();
          const shift = rect.left - (box.left + column * cell);
          if (!off && Math.abs(shift) > slack) problems.push(`row ${line + 1} column ${column + 1} "${node.data[at]}" is ${shift.toFixed(3)} px off its cell`);
          off ||= Math.abs(shift) > slack;
          right = rect.right;
        }
      }
      if (right > box.right + slack / 2) problems.push(`row ${line + 1} ends ${(right - box.right).toFixed(3)} px past the screen`);
    });
    return { cols, cell, screen: { top: box.top, right: box.right, height: rows.at(-1)!.getBoundingClientRect().bottom - box.top }, problems };
  }, { cols, slack, status: STATUS, fullRows: FULL_ROWS });
}

/* settled: whether the size the terminal last told the node is the one this step waits for. */
async function expectTextInCells(page: Page, sizes: number[], screenshot: string, settled: (cols: number) => boolean = () => true) {
  let report: CellReport | null = null;
  await expect.poll(async () => {
    const cols = sizes.at(-1);
    report = cols && settled(cols) ? await measureCells(page, cols, GRID_SLACK) : null;
    return report !== null;
  }).toBe(true);
  const { problems, cols, screen } = report!;
  await page.screenshot({ path: `${screenshot}.png` });
  /* The right end of the full rows, close up: where a cut character shows. */
  await page.screenshot({ path: `${screenshot}-edge.png`, clip: { x: screen.right - 160, y: screen.top, width: 180, height: screen.height } });
  expect(cols).toBeGreaterThan(30);
  expect(problems).toEqual([]);
  return report!;
}

for (const dpr of [1, 2]) {
  test.describe(`terminal text on its cell grid at device pixel ratio ${dpr}`, () => {
    test.use({ deviceScaleFactor: dpr });

    for (const fontCase of CASES) {
      test(`${fontCase.font}: every character of a full row stays in its cell, wide and narrow`, async ({ page }, info) => {
        const name = (width: number) => info.outputPath(`cells-${fontCase.font.split(' ')[0]!.toLowerCase()}-dpr${dpr}-${width}`);
        const { sizes, errors } = await openTerminal(page, fontCase, WIDE);
        const wide = await expectTextInCells(page, sizes, name(WIDE));
        expect(wide.cols).toBeGreaterThan(100);

        await page.setViewportSize({ width: NARROW, height: 900 });
        await expectTextInCells(page, sizes, name(NARROW), cols => cols < wide.cols);
        expect(errors).toEqual([]);
      });
    }
  });
}
