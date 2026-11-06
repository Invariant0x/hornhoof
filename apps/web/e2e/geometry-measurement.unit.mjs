import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geometryMeasurement } from './geometry-measurement.ts';
import { compareGeometry } from './geometry-compare.mjs';

/* Unit records only. These numbers and hashes never claim a browser execution or a runtime/export receipt. */
const identities = { sourceSha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), dataSha256: 'c'.repeat(64), fontsSha256: 'd'.repeat(64) };
const caseId = 'notebook/light/short/375/full';
const iconIds = ['window.close', 'window.minimize', 'window.full'];
function capture() {
  return { ...identities, caseId, engine: 'chromium', status: 'measured', screenshotSha256: 'e'.repeat(64),
    session: 'synthetic-unit-only-value',
    geometry: { panel: { x: 16, y: 0, width: 343, height: 700 }, body: { x: 28, y: 44, width: 319, height: 640 },
      viewport: { width: 375, height: 812, dpr: 1 },
      icons: iconIds.map(id => ({ id, name: 'Localized label', dx: 99, dy: -99,
        button: { x: 10, y: 20, width: 26, height: 26 }, svg: { x: 15, y: 25, width: 16, height: 16 } })),
      clips: [], horizontalOverflow: [], pageHorizontalOverflow: false,
      intentionalNavigation: [{ className: 'side-panels', width: 375, scrollWidth: 700, scrollLeft: 0 }] } };
}
const dimensions = { 'panel.width': 343, 'panel.height': 700, 'body.width': 319, 'body.height': 640,
  'window.close.width': 26, 'window.close.height': 26, 'window.minimize.width': 26, 'window.minimize.height': 26,
  'window.full.width': 26, 'window.full.height': 26 };
const manifest = { ...identities, cases: [{ id: caseId, dimensions: Object.keys(dimensions), icons: iconIds }] };

test('normalizes recorded rectangles and identities without copying credentials or declaring readiness', () => {
  assert.deepEqual(geometryMeasurement(capture()), { ...identities, engine: 'chromium', caseId, status: 'measured',
    screenshotSha256: 'e'.repeat(64), dpr: 1, dimensions, icons: iconIds.map(id => ({ id, dx: 0, dy: 0 })), clipping: [], horizontalOverflow: [] });
});

test('keeps one case identity across engines and supplies the existing strict comparison', () => {
  const rows = ['chromium', 'firefox', 'webkit'].map(engine => geometryMeasurement({ ...capture(), engine }));
  assert.deepEqual(compareGeometry(rows, manifest), { comparedCases: 1, expectedCases: 1, issues: [] });
});

test('derives unrounded centers from rectangles and retains a 1.1px dimension mismatch', () => {
  const raw = capture(); raw.geometry.icons[0].svg.x = 15.6; raw.geometry.icons[0].svg.y = 25.8;
  const row = geometryMeasurement(raw);
  assert.ok(Math.abs(row.icons[0].dx - 0.6) < 1e-9); assert.ok(Math.abs(row.icons[0].dy - 0.8) < 1e-9);
  const wide = capture(); wide.engine = 'webkit'; wide.geometry.panel.width = 344.1;
  const codes = compareGeometry([row, geometryMeasurement({ ...capture(), engine: 'firefox' }), geometryMeasurement(wide)], manifest).issues.map(x => x.code);
  assert.ok(codes.includes('icon-center')); assert.ok(codes.includes('dimension-range'));
});

test('preserves clipping and element/document overflow even beside intentional navigation', () => {
  const raw = capture();
  raw.geometry.clips.push({ text: 'Full notebook text', owner: 'side-panels' });
  raw.geometry.horizontalOverflow.push({ className: 'notebook', clientWidth: 319, scrollWidth: 400 });
  raw.geometry.pageHorizontalOverflow = true;
  const row = geometryMeasurement(raw);
  assert.deepEqual(row.clipping, raw.geometry.clips);
  assert.deepEqual(row.horizontalOverflow, [...raw.geometry.horizontalOverflow, { selector: 'html', reason: 'viewport-overflow' }]);
});

test('preserves duplicate icon evidence for the comparator to reject', () => {
  const raw = capture(); raw.geometry.icons.push(raw.geometry.icons[0]);
  const rows = [geometryMeasurement(raw), geometryMeasurement({ ...capture(), engine: 'firefox' }), geometryMeasurement({ ...capture(), engine: 'webkit' })];
  assert.ok(compareGeometry(rows, manifest).issues.some(x => x.code === 'duplicate-icon'));
});

test('takes DPR from the measured viewport instead of the requested metadata', () => {
  const raw = { ...capture(), dpr: 1 }; raw.geometry.viewport.dpr = 2;
  assert.equal(geometryMeasurement(raw).dpr, 2);
});

for (const field of Object.keys(identities)) test('rejects a missing capture identity: ' + field, () => {
  const raw = capture(); delete raw[field];
  assert.throws(() => geometryMeasurement(raw), /identity/i);
});
for (const status of ['NOT_RUN', 'failed', 'timeout']) test('never promotes capture status ' + status, () => {
  assert.throws(() => geometryMeasurement({ ...capture(), status }), /measured/i);
});
test('rejects a substituted engine', () => { assert.throws(() => geometryMeasurement({ ...capture(), engine: 'host-chrome' }), /engine/i); });
test('rejects an absent case denominator identity', () => { assert.throws(() => geometryMeasurement({ ...capture(), caseId: '' }), /case/i); });
test('rejects missing screenshot identity', () => { const raw = capture(); delete raw.screenshotSha256; assert.throws(() => geometryMeasurement(raw), /screenshot/i); });
for (const field of ['clips', 'horizontalOverflow', 'pageHorizontalOverflow', 'viewport', 'icons', 'body']) test('rejects missing raw geometry evidence: ' + field, () => {
  const raw = capture(); delete raw.geometry[field]; assert.throws(() => geometryMeasurement(raw), /geometry/i);
});
test('rejects an icon without its stable identity', () => {
  const raw = capture(); delete raw.geometry.icons[0].id; assert.throws(() => geometryMeasurement(raw), /icon/i);
});
test('rejects missing SVG rectangles rather than dropping a control', () => {
  const raw = capture(); delete raw.geometry.icons[0].svg; assert.throws(() => geometryMeasurement(raw), /rectangle/i);
});
