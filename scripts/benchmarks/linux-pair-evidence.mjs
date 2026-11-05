import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const FRAME_BYTES = 700 * 1024;
const FILE_BYTES = 50 * 1024 * 1024;
const EVIDENCE_FILES = 18;
const WRAPPER_FILES = ['pair-measurements.log', 'pair-stage-logs.tar.gz'];

export function evidenceFrame(result, artifacts) {
  const frame = { version: 2, result, artifacts };
  const line = 'HH_PAIR_EVIDENCE ' + JSON.stringify(frame);
  assert.ok(Buffer.byteLength(line + '\n') <= FRAME_BYTES, 'Evidence frame exceeds the 700 KiB runner tail budget');
  return line;
}

function transportLimits(options) {
  const { fileBytes = FILE_BYTES, maxFiles = EVIDENCE_FILES } = options;
  assert.ok(Number.isInteger(fileBytes) && fileBytes > 0 && fileBytes <= FILE_BYTES, 'Invalid transport file limit');
  assert.ok(Number.isInteger(maxFiles) && maxFiles > 0 && maxFiles <= EVIDENCE_FILES, 'Invalid transport file count');
  return { fileBytes, maxFiles };
}

function availableFiles(folder, maxFiles, owned = []) {
  const files = readdirSync(folder).filter(name => lstatSync(join(folder, name)).isFile() && !WRAPPER_FILES.includes(name) && !owned.includes(name));
  const slots = Math.min(maxFiles, EVIDENCE_FILES - files.length);
  assert.ok(slots > 0, 'No transport output slots remain after reserving the wrapper files');
  return slots;
}

function chunkName(encoding, part) {
  const base = 'pair-evidence.ndjson';
  if (encoding === 'gzip') return base + '.gz' + (part ? '.part-' + String(part).padStart(6, '0') : '');
  return base + (part ? '.part-' + String(part).padStart(6, '0') + '.ndjson' : '');
}

function journal(folder, fileBytes) {
  const names = [chunkName('plain', 0)];
  writeFileSync(join(folder, names[0]), '', { flag: 'wx' });
  let size = 0;
  return {
    names,
    append(bytes) {
      let offset = 0;
      while (offset < bytes.length) {
        if (size === fileBytes) {
          names.push(chunkName('plain', names.length));
          writeFileSync(join(folder, names.at(-1)), '', { flag: 'wx' });
          size = 0;
        }
        const count = Math.min(fileBytes - size, bytes.length - offset);
        appendFileSync(join(folder, names.at(-1)), bytes.subarray(offset, offset + count));
        size += count; offset += count;
      }
    },
  };
}

function artifactsFor(folder, names, encoding) {
  return names.map((name, part) => {
    const bytes = readFileSync(join(folder, name));
    return { name, encoding, part, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
}

function compressedFiles(folder, compressed, fileBytes) {
  const names = [];
  for (let offset = 0; offset < compressed.length; offset += fileBytes) {
    const name = chunkName('gzip', names.length);
    writeFileSync(join(folder, name), compressed.subarray(offset, offset + fileBytes), { flag: 'wx' });
    names.push(name);
  }
  return names;
}

function finishEvidence(folder, writer, limits, result) {
  const slots = availableFiles(folder, limits.maxFiles, writer.names);
  const compressed = gzipSync(Buffer.concat(writer.names.map(name => readFileSync(join(folder, name)))));
  const compressedCount = Math.ceil(compressed.length / limits.fileBytes);
  assert.ok(compressedCount <= slots, 'Complete evidence exceeds transport file count; raw journal retained');
  const keepPlain = compressedCount + writer.names.length <= slots;
  const zipped = compressedFiles(folder, compressed, limits.fileBytes);
  const artifacts = [...(keepPlain ? artifactsFor(folder, writer.names, 'plain') : []), ...artifactsFor(folder, zipped, 'gzip')];
  const frame = evidenceFrame(result, artifacts);
  if (!keepPlain) {
    const saved = join(folder, 'pair-evidence-source'); mkdirSync(saved);
    for (const name of writer.names) renameSync(join(folder, name), join(saved, name));
  }
  return frame;
}

export function createEvidence(folder, options = {}) {
  assert.ok(folder, 'HH_OUT must name durable output storage');
  assert.ok(statSync(folder).isDirectory(), 'HH_OUT must be a directory');
  const limits = transportLimits(options);
  availableFiles(folder, limits.maxFiles);
  const writer = journal(folder, limits.fileBytes);
  return {
    record(kind, value) {
      writer.append(Buffer.from(JSON.stringify({ kind, value }) + '\n'));
    },
    finish(result) {
      return finishEvidence(folder, writer, limits, result);
    },
  };
}
