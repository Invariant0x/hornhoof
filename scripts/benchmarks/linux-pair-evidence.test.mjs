import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { createEvidence } from './linux-pair-evidence.mjs';

function folder(t) {
  const out = mkdtempSync(join(tmpdir(), 'hh-pair-transport-'));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  return out;
}

test('transport chunks complete compressed evidence within file and count limits', t => {
  const out = folder(t), record = { kind: 'RAW', value: randomBytes(4096).toString('base64') };
  const writer = createEvidence(out, { fileBytes: 1024, maxFiles: 6 });
  writer.record(record.kind, record.value);
  const frame = JSON.parse(writer.finish({ diagnosticOnly: true }).slice('HH_PAIR_EVIDENCE '.length));
  assert.ok(frame.artifacts.length > 1 && frame.artifacts.length <= 6);
  assert.ok(frame.artifacts.every(x => x.bytes <= 1024));
  const parts = frame.artifacts.filter(x => x.encoding === 'gzip').sort((a, b) => a.part - b.part);
  assert.ok(parts.length > 1);
  const plain = gunzipSync(Buffer.concat(parts.map(x => readFileSync(join(out, x.name))))).toString();
  assert.deepEqual(plain.trim().split('\n').map(JSON.parse), [record]);
});

test('transport impossibility stays invalid and leaves every journal byte intact', t => {
  const out = folder(t), record = { kind: 'RAW', value: randomBytes(4096).toString('base64') };
  const writer = createEvidence(out, { fileBytes: 256, maxFiles: 2 });
  writer.record(record.kind, record.value);
  assert.throws(() => writer.finish({ valid: true }), /transport/i);
  const raw = readdirSync(out).filter(x => x.endsWith('.ndjson')).sort().map(x => readFileSync(join(out, x)));
  assert.deepEqual(Buffer.concat(raw).toString().trim().split('\n').map(JSON.parse), [record]);
});

test('transport reserves the wrapper files and rejects exhausted output slots', t => {
  const out = folder(t);
  for (let i = 0; i < 18; i++) writeFileSync(join(out, 'a-' + i + '.log'), 'existing');
  assert.throws(() => createEvidence(out), /transport/i);
});

test('transport configuration cannot raise real file or count limits', t => {
  const out = folder(t);
  for (const [i, limits] of [{ fileBytes: 52428801 }, { maxFiles: 19 }].entries()) {
    const path = join(out, String(i)); mkdirSync(path);
    assert.throws(() => createEvidence(path, limits), /transport/i);
  }
});
