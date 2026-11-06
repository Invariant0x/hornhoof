/* One explicitly authorized compatibility probe, not the geometry acceptance matrix. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { chromium, firefox, webkit } from '@playwright/test';
import { geometryServer } from './geometry-fixture.ts';

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const require = createRequire(import.meta.url);
const playwrightVersion = JSON.parse(readFileSync(require.resolve('@playwright/test/package.json'), 'utf8')).version;
assert.equal(playwrightVersion, '1.64.1');
assert.notEqual(process.getuid(), 0, 'This probe is authorized without root only');
process.env.HH_GEOMETRY_SOURCE_ROOT = process.cwd();
process.env.HH_GEOMETRY_SOURCE_SHA = sha;
const fixture = await geometryServer();
const locale = fixture.locales.at(-1);
assert.ok(locale, 'The real source must supply its locale ranking');
const profile = { viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, locale: locale.id,
  timezoneId: 'UTC', reducedMotion: 'reduce', colorScheme: 'light' };
const outcomes = [];
console.log('HH_PROBE_INPUT ' + JSON.stringify({ sourceSha: sha, harnessSha: sha, playwrightVersion, profile,
  screen: 'company-notebook', theme: 'light', selectedLocale: locale.id,
  localeRankings: fixture.locales.map(({ id, score, direction }) => ({ id, score, direction })),
  dataSha256: fixture.dataSha256, fontsSha256: fixture.fontsSha256, fontAssets: fixture.fontAssets,
  imageDigest: null, canonicalRuntimeReceipt: false, acceptanceMatrix: false }));

try {
  for (const [engine, browserType] of Object.entries({ chromium, firefox, webkit })) {
    const outcome = { engine, executablePath: browserType.executablePath(), browserVersion: null,
      launch: 'NOT_RUN', screen: 'NOT_RUN', screenshot: 'NOT_RUN', errors: [], failedRequests: [] };
    let browser, page;
    try {
      browser = await browserType.launch({ headless: true, timeout: 15_000 });
      outcome.browserVersion = browser.version();
      outcome.launch = 'PASSED';
      const context = await browser.newContext(profile);
      await context.addCookies([{ name: 'hh_session', value: fixture.session, url: fixture.origin }]);
      await context.addInitScript(language => {
        localStorage.setItem('hh-lang', language);
        localStorage.setItem('hh-theme', 'light');
      }, locale.id);
      page = await context.newPage();
      page.setDefaultTimeout(8_000);
      page.on('pageerror', error => outcome.errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') outcome.errors.push(message.text()); });
      page.on('requestfailed', request => outcome.failedRequests.push({ method: request.method(),
        path: new URL(request.url()).pathname, error: request.failure()?.errorText }));
      await page.goto(fixture.origin, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.getByRole('button', { name: locale.labels.openOrchestrator, exact: true }).click();
      const window = page.locator('.orch:not([hidden])');
      await window.locator(':scope > .t-bar').getByRole('button', { name: locale.labels.notebook, exact: true }).click();
      const notebook = page.locator('.side-panel .acard').filter({ has: page.locator('.notebook') });
      await notebook.locator('.notebook li').filter({ hasText: fixture.note }).waitFor();
      await page.evaluate(async () => {
        await document.fonts.ready;
        await document.fonts.load('14px Onest');
        await document.fonts.load('14px Tektur');
      });
      const geometry = await page.evaluate(() => {
        const box = element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { x, y, width, height };
        };
        const panel = document.querySelector('.side-panel .acard:has(.notebook)');
        const controls = [...document.querySelectorAll('.orch .t-bar button:not(.btn)')].map(button => {
          const b = box(button), svg = button.querySelector('svg'), s = svg ? box(svg) : null;
          return { className: button.className, label: button.getAttribute('aria-label'), button: b, svg: s,
            dx: s ? s.x + s.width / 2 - b.x - b.width / 2 : null,
            dy: s ? s.y + s.height / 2 - b.y - b.height / 2 : null };
        });
        return { panel: box(panel), controls, dpr: devicePixelRatio,
          viewport: { width: innerWidth, height: innerHeight },
          documentScrollWidth: document.documentElement.scrollWidth,
          fonts: [...document.fonts].map(({ family, status, weight, style }) => ({ family, status, weight, style })) };
      });
      console.log('HH_PROBE_GEOMETRY ' + JSON.stringify({ engine, sourceSha: sha, ...geometry }));
      assert.equal(geometry.dpr, 1);
      assert.equal(outcome.errors.length, 0, 'The real page emitted errors');
      assert.equal(outcome.failedRequests.length, 0, 'The real page had failed requests');
      outcome.screen = 'PASSED';
    } catch (error) {
      if (outcome.launch === 'NOT_RUN') outcome.launch = 'FAILED';
      else outcome.screen = 'FAILED';
      outcome.error = error.stack ?? String(error);
    } finally {
      if (page) {
        try {
          const png = await page.screenshot({ animations: 'disabled', timeout: 8_000 });
          assert.ok(png.length <= 128 * 1024, `PNG exceeds the fixed stdout budget: ${png.length}`);
          const sha256 = createHash('sha256').update(png).digest('hex');
          console.log('HH_PROBE_PNG ' + JSON.stringify({ engine, sourceSha: sha, screen: outcome.screen,
            bytes: png.length, sha256, base64: png.toString('base64') }));
          outcome.screenshot = 'STDOUT_EXPORTED';
          outcome.png = { bytes: png.length, sha256 };
        } catch (error) {
          outcome.screenshot = 'FAILED';
          outcome.screenshotError = error.stack ?? String(error);
        }
      }
      try { await browser?.close(); }
      catch (error) { outcome.cleanupError = error.stack ?? String(error); }
      outcomes.push(outcome);
      console.log('HH_PROBE_ENGINE ' + JSON.stringify(outcome));
    }
  }
} finally {
  await fixture.stop();
}
const complete = outcomes.length === 3 && outcomes.every(row => row.launch === 'PASSED' && row.screen === 'PASSED' && row.screenshot === 'STDOUT_EXPORTED' && !row.cleanupError);
console.log('HH_PROBE_RESULT ' + JSON.stringify({ sourceSha: sha, playwrightVersion, complete,
  engineCount: outcomes.length, acceptedGeometryResult: false, imageDigest: null,
  outputTransport: 'bounded stdout PNG bytes; manual attachment after hash verification',
  remaining: ['trusted image digest/runtime receipt', 'automated artifact export receipt', 'same harness on approved main/candidate pair',
    'complete 89-row geometry, locale, theme and viewport matrix'] }));
process.exitCode = complete ? 0 : 1;
