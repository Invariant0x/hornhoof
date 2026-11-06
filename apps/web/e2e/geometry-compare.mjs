import assert from 'node:assert/strict';

const ENGINES = ['chromium', 'firefox', 'webkit'];
const IDENTITIES = ['sourceSha', 'harnessSha', 'dataSha256', 'fontsSha256'];
const positive = value => Number.isFinite(value) && value > 0;

function validateManifest(manifest) {
  assert.ok(Array.isArray(manifest.cases) && manifest.cases.length > 0, 'An explicit nonempty expected case list is required');
  const cases = new Map();
  for (const expected of manifest.cases) {
    assert.ok(typeof expected.id === 'string' && expected.id.length > 0, 'A case must have an id');
    assert.ok(!cases.has(expected.id), 'Duplicate manifest case: ' + expected.id);
    assert.ok(Array.isArray(expected.dimensions) && expected.dimensions.length > 0, 'A case must have key dimensions');
    assert.ok(Array.isArray(expected.icons), 'A case must declare its icon inventory');
    cases.set(expected.id, expected);
  }
  for (const key of IDENTITIES) assert.match(manifest[key] ?? '', key.endsWith('Sha') ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/, 'Invalid manifest identity: ' + key);
  return cases;
}

function indexMeasurements(rows, cases, issues) {
  const indexed = new Map([...cases.keys()].map(id => [id, new Map()]));
  for (const row of rows) {
    if (!ENGINES.includes(row.engine)) { issues.push({ code: 'unexpected-engine', engine: row.engine }); continue; }
    const byEngine = indexed.get(row.caseId);
    if (!byEngine) { issues.push({ code: 'unexpected-case', caseId: row.caseId, engine: row.engine }); continue; }
    if (byEngine.has(row.engine)) { issues.push({ code: 'duplicate-measurement', caseId: row.caseId, engine: row.engine }); continue; }
    byEngine.set(row.engine, row);
  }
  return indexed;
}

function pinnedMeasurement(row, manifest, issues) {
  let valid = true;
  for (const key of IDENTITIES) if (row[key] !== manifest[key]) {
    issues.push({ code: 'identity-mismatch', caseId: row.caseId, engine: row.engine, field: key }); valid = false;
  }
  if (row.status !== 'measured') {
    issues.push({ code: 'not-measured', caseId: row.caseId, engine: row.engine, status: row.status }); valid = false;
  }
  if (row.dpr !== 1) { issues.push({ code: 'dpr-mismatch', caseId: row.caseId, engine: row.engine, actual: row.dpr }); valid = false; }
  return valid;
}

function contentEvidence(row, issues) {
  for (const field of ['clipping', 'horizontalOverflow']) {
    if (!Array.isArray(row[field])) { issues.push({ code: 'invalid-content-evidence', caseId: row.caseId, engine: row.engine, field }); continue; }
    if (row[field].length) issues.push({ code: 'content-overflow', caseId: row.caseId, engine: row.engine, field, defects: row[field] });
  }
}

function iconEvidence(row, expected, issues) {
  const icons = Array.isArray(row.icons) ? row.icons : [];
  for (const id of expected.icons) {
    const found = icons.filter(icon => icon.id === id);
    if (!found.length) { issues.push({ code: 'missing-icon', caseId: row.caseId, engine: row.engine, icon: id }); continue; }
    if (found.length > 1) { issues.push({ code: 'duplicate-icon', caseId: row.caseId, engine: row.engine, icon: id }); continue; }
    const icon = found[0];
    for (const axis of ['dx', 'dy']) if (!Number.isFinite(icon[axis]) || Math.abs(icon[axis]) > 0.5) {
      issues.push({ code: 'icon-center', caseId: row.caseId, engine: row.engine, icon: id, axis, actual: icon[axis], maximum: 0.5 });
    }
  }
}

function dimensionEvidence(rows, expected, issues) {
  for (const name of expected.dimensions) {
    const values = [];
    for (const row of rows) {
      const value = row.dimensions?.[name];
      if (positive(value)) values.push(value);
      else issues.push({ code: 'invalid-dimension', caseId: row.caseId, engine: row.engine, dimension: name, actual: value });
    }
    if (values.length !== ENGINES.length) continue;
    const difference = Math.max(...values) - Math.min(...values);
    if (difference > 1) issues.push({ code: 'dimension-range', caseId: expected.id, dimension: name, difference, maximum: 1 });
  }
}

function completeCase(byEngine, expected, manifest, issues) {
  const rows = [];
  for (const engine of ENGINES) {
    const row = byEngine.get(engine);
    if (!row) { issues.push({ code: 'missing-engine', caseId: expected.id, engine }); continue; }
    if (pinnedMeasurement(row, manifest, issues)) rows.push(row);
  }
  return rows;
}

/* This compares measured JSON only. It never certifies a browser execution, a Docker context or a runtime receipt. */
export function compareGeometry(rows, manifest) {
  assert.ok(Array.isArray(rows), 'Measurements must be an array');
  const cases = validateManifest(manifest), issues = [];
  const indexed = indexMeasurements(rows, cases, issues);
  let comparedCases = 0;
  for (const [id, expected] of cases) {
    const measured = completeCase(indexed.get(id), expected, manifest, issues);
    for (const row of measured) { contentEvidence(row, issues); iconEvidence(row, expected, issues); }
    if (measured.length !== ENGINES.length) continue;
    dimensionEvidence(measured, expected, issues);
    comparedCases++;
  }
  return { comparedCases, expectedCases: cases.size, issues };
}
