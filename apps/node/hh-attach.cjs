#!/usr/bin/env node
// hh-attach FILE...: sends pictures from an agent's turn to Hornhoof and prints "FILE ID" for each, to pass the ids to
// ask_person. hh-attach --task 12 FILE... puts files of any kind on task 12 under their own names instead, for any agent
// of the company to download with hh-fetch. The node puts the address and the turn's token into HH_ATTACH_URL and
// HH_ATTACH_PASS for each turn.
'use strict';
const { readFileSync } = require('node:fs');
const { basename } = require('node:path');

const USAGE = 'Usage: hh-attach FILE... (PNG, JPEG or WebP, up to 3 MB each), or hh-attach --task 12 FILE... (any file, up to 50 MB each)';

async function main() {
  const url = process.env.HH_ATTACH_URL;
  const pass = process.env.HH_ATTACH_PASS;
  const args = process.argv.slice(2);
  const task = args[0] === '--task' ? args[1] : undefined;
  const files = args[0] === '--task' ? args.slice(2) : args;
  if (!url || !pass) throw new Error('hh-attach works only inside a Hornhoof turn.');
  if (!files.length || (args[0] === '--task' && !task)) throw new Error(USAGE);
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new Error(`Cannot read ${file}.`);
    }
    const to = task ? `${url}?${new URLSearchParams({ task: task.replace(/^#/, ''), name: basename(file) })}` : url;
    const res = await fetch(to, { method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/octet-stream' }, body: bytes });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) throw new Error(`${file}: ${(body.error && body.error.message) || `Hornhoof answered ${res.status}.`}`);
    process.stdout.write(`${file} ${body.id}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
