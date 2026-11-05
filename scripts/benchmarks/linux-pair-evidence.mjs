import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const FRAME_BYTES = 700 * 1024;

export function evidenceFrame(result, artifacts) {
  const frame = { version: 2, result, artifacts };
  const line = 'HH_PAIR_EVIDENCE ' + JSON.stringify(frame);
  assert.ok(Buffer.byteLength(line + '\n') <= FRAME_BYTES, 'Evidence frame exceeds the 700 KiB runner tail budget');
  return line;
}

export function createEvidence(folder) {
  assert.ok(folder, 'HH_OUT must name durable output storage');
  assert.ok(statSync(folder).isDirectory(), 'HH_OUT must be a directory');
  const plain = join(folder, 'pair-evidence.ndjson');
  writeFileSync(plain, '', { flag: 'wx' });
  return {
    record(kind, value) {
      appendFileSync(plain, JSON.stringify({ kind, value }) + '\n');
    },
    finish(result) {
      const source = readFileSync(plain);
      const compressed = gzipSync(source);
      const name = 'pair-evidence.ndjson.gz';
      writeFileSync(join(folder, name), compressed, { flag: 'wx' });
      const artifacts = [['pair-evidence.ndjson', source], [name, compressed]].map(([name, bytes]) => ({
        name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      }));
      return evidenceFrame(result, artifacts);
    },
  };
}
