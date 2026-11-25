#!/usr/bin/env node
// hh-fetch TASK FILE [WHERE]: downloads a file an agent put on a task with hh-attach --task, by its name or id, and prints
// where it saved it: into the folder it runs in under the file's name, into the folder WHERE, or as the file WHERE.
// hh-fetch message ID [WHERE] does the same for a picture a person sent this agent with a message. The node puts the
// address and the turn's token into HH_ATTACH_URL and HH_ATTACH_PASS for each turn. A file already there is downloaded
// again only when Hornhoof's has other bytes.
'use strict';
const { createHash } = require('node:crypto');
const { createReadStream, createWriteStream, statSync } = require('node:fs');
const { mkdtemp, rename, rm } = require('node:fs/promises');
const { basename, dirname, join } = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

async function main() {
  const url = process.env.HH_ATTACH_URL;
  const pass = process.env.HH_ATTACH_PASS;
  const [task, file, where] = process.argv.slice(2);
  if (!url || !pass) throw new Error('hh-fetch works only inside a Hornhoof turn.');
  if (!task || !file) throw new Error('Usage: hh-fetch TASK FILE [WHERE], as in hh-fetch 12 build.tar.gz, or hh-fetch message ID [WHERE] for a picture that came with a message');
  const folder = where !== undefined && statSync(where, { throwIfNoEntry: false })?.isDirectory();
  const at = name => (where === undefined ? name : folder ? join(where, name) : where);
  const ask = headers => fetch(`${url}/file?${new URLSearchParams({ task: task.replace(/^#/, ''), file })}`, { headers: { authorization: `Bearer ${pass}`, ...headers } });
  /* The file where it would land, by the name it is asked by: Hornhoof says when it has the same bytes. */
  const there = at(basename(file));
  const had = statSync(there, { throwIfNoEntry: false })?.isFile() ? await hashOf(there) : null;
  let res = await ask(had ? { 'if-none-match': `"${had}"` } : {});
  if (res.status === 304) {
    if (at(savedName(res, file)) === there) return void process.stdout.write(`${there}\n`);
    res = await ask({});
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body.error && body.error.message) || `Hornhoof answered ${res.status}.`);
  }
  const path = at(savedName(res, file));
  /* Keep a partial download beside its destination until it is complete, so a lost response preserves the old file. */
  const temporary = await mkdtemp(join(dirname(path), '.hh-fetch-'));
  try {
    const pending = join(temporary, 'file');
    const mode = statSync(path, { throwIfNoEntry: false })?.mode ?? 0o666;
    await pipeline(res.body ? Readable.fromWeb(res.body) : Readable.from([]), createWriteStream(pending, { mode }));
    await rename(pending, path);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  process.stdout.write(`${path}\n`);
}

/* Only the name: a file never lands outside the folder it is saved in. */
function savedName(res, file) {
  try {
    return basename(decodeURIComponent(res.headers.get('x-file-name') || '')) || basename(file);
  } catch {
    return basename(file);
  }
}

async function hashOf(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
