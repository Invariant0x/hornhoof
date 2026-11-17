#!/usr/bin/env node
// hh-fetch TASK FILE [WHERE]: downloads a file an agent put on a task with hh-attach --task, by its name or id, and prints
// where it saved it: into the folder it runs in under the file's name, into the folder WHERE, or as the file WHERE.
// hh-fetch message ID [WHERE] does the same for a picture a person sent this agent with a message. The node puts the
// address and the turn's token into HH_ATTACH_URL and HH_ATTACH_PASS for each turn.
'use strict';
const { createWriteStream, statSync } = require('node:fs');
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
  const res = await fetch(`${url}/file?${new URLSearchParams({ task: task.replace(/^#/, ''), file })}`, { headers: { authorization: `Bearer ${pass}` } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body.error && body.error.message) || `Hornhoof answered ${res.status}.`);
  }
  /* Only the name: a file never lands outside the folder it is saved in. */
  let name = basename(file);
  try {
    name = basename(decodeURIComponent(res.headers.get('x-file-name') || '')) || name;
  } catch {
    /* Keep the name it was asked by. */
  }
  const folder = where !== undefined && statSync(where, { throwIfNoEntry: false })?.isDirectory();
  const path = where === undefined ? name : folder ? join(where, name) : where;
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

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
