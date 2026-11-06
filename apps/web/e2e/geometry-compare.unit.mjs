import assert from 'node:assert/strict';
import { test } from 'vitest';
import { compareGeometry } from './geometry-compare.mjs';

/* These are unit inputs, not browser executions or a TestEnvironment readiness receipt. */
const identities = { sourceSha: 'a'.repeat(40), harnessSha: 'b'.repeat(40), dataSha256: 'c'.repeat(64), fontsSha256: 'd'.repeat(64) };
const manifest = { ...identities, cases: [{ id: 'notebook/light/short/375/full', dimensions: ['panel.width', 'close.width', 'close.height'], icons: ['close'] }] };
function rows() {
  return ['chromium', 'firefox', 'webkit'].map(engine => ({ ...identities, engine, caseId: 'notebook/light/short/375/full', status: 'measured',
    dpr: 1, dimensions: { 'panel.width': 343, 'close.width': 26, 'close.height': 26 }, icons: [{ id: 'close', dx: 0, dy: 0 }], clipping: [], horizontalOverflow: [] }));
}

function codes(input, expected = manifest) { return compareGeometry(input, expected).issues.map(x => x.code); }

test('compares a complete three-engine case without asserting runtime readiness', () => {
  const result = compareGeometry(rows(), manifest);
  assert.deepEqual(result.issues, []);
  assert.equal(result.comparedCases, 1);
  assert.equal('runtimeReady' in result, false);
  assert.equal('passed' in result, false);
});

test('keeps inclusive 0.5px centers and 1px size limits', () => {
  const input = rows(); input[1].dimensions['panel.width'] = 344;
  input[2].icons[0].dx = -0.5; input[2].icons[0].dy = 0.5;
  assert.deepEqual(codes(input), []);
});

for (const engine of ['chromium', 'firefox', 'webkit']) test('rejects a missing ' + engine + ' instead of shrinking coverage', () => {
  assert.ok(codes(rows().filter(x => x.engine !== engine)).includes('missing-engine'));
});

test('retains NOT_RUN as a missing measurement', () => {
  const input = rows(); input[2].status = 'NOT_RUN';
  assert.ok(codes(input).includes('not-measured'));
});

test('rejects a duplicate engine/case even when its measurements agree', () => {
  const input = rows(); input.push(input[0]);
  assert.ok(codes(input).includes('duplicate-measurement'));
});

test('rejects an unknown engine instead of substituting its metrics', () => {
  const input = rows(); input[2].engine = 'host-chrome';
  assert.ok(codes(input).includes('unexpected-engine'));
  assert.ok(codes(input).includes('missing-engine'));
});

for (const key of ['sourceSha', 'harnessSha', 'dataSha256', 'fontsSha256']) test('rejects a mismatched ' + key, () => {
  const input = rows(); input[1][key] = 'e'.repeat(identities[key].length);
  assert.ok(codes(input).includes('identity-mismatch'));
});

test('compares against an explicit expected case list even when every engine omits a case', () => {
  const expected = { ...manifest, cases: [...manifest.cases, { id: 'notebook/dark/long/1440/full', dimensions: ['panel.width'], icons: ['close'] }] };
  assert.ok(codes(rows(), expected).includes('missing-engine'));
});

test('rejects unregistered measurements rather than hiding unexpected coverage', () => {
  const input = rows(); input.push({ ...input[0], caseId: 'unknown-panel' });
  assert.ok(codes(input).includes('unexpected-case'));
});

for (const axis of ['dx', 'dy']) for (const offset of [-0.6, 0.6]) test('rejects ' + axis + '=' + offset + ' with the original 0.5px limit', () => {
  const input = rows(); input[0].icons[0][axis] = offset;
  assert.ok(codes(input).includes('icon-center'));
});

test('rejects a 1.1px range across engines with the original 1px limit', () => {
  const input = rows(); input[2].dimensions['panel.width'] = 344.1;
  assert.ok(codes(input).includes('dimension-range'));
});

for (const value of [NaN, Infinity, 0, -1]) test('rejects an invalid dimension ' + String(value), () => {
  const input = rows(); input[1].dimensions['close.width'] = value;
  assert.ok(codes(input).includes('invalid-dimension'));
});

test('rejects a missing required dimension', () => {
  const input = rows(); delete input[1].dimensions['close.height'];
  assert.ok(codes(input).includes('invalid-dimension'));
});

test('rejects missing or duplicate icon measurements', () => {
  const missing = rows(); missing[0].icons = [];
  assert.ok(codes(missing).includes('missing-icon'));
  const duplicate = rows(); duplicate[0].icons.push({ ...duplicate[0].icons[0] });
  assert.ok(codes(duplicate).includes('duplicate-icon'));
});

test('rejects non-finite icon offsets', () => {
  const input = rows(); input[0].icons[0].dy = NaN;
  assert.ok(codes(input).includes('icon-center'));
});

for (const key of ['clipping', 'horizontalOverflow']) test('retains actual ' + key + ' defects', () => {
  const input = rows(); input[2][key] = [{ element: 'notebook note', right: 1500, availableRight: 343 }];
  assert.ok(codes(input).includes('content-overflow'));
});

test('rejects missing defect arrays instead of treating absent evidence as clean', () => {
  const input = rows(); delete input[1].clipping;
  assert.ok(codes(input).includes('invalid-content-evidence'));
});

test('rejects DPR drift between otherwise matching measurements', () => {
  const input = rows(); input[1].dpr = 2;
  assert.ok(codes(input).includes('dpr-mismatch'));
});

test('rejects an empty denominator and duplicate manifest cases', () => {
  assert.throws(() => compareGeometry([], { ...manifest, cases: [] }), /case/i);
  assert.throws(() => compareGeometry(rows(), { ...manifest, cases: [manifest.cases[0], manifest.cases[0]] }), /duplicate/i);
});
