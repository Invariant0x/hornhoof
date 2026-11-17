#!/usr/bin/env node
// hh-attach FILE...: sends pictures from an agent's turn to Hornhoof and prints "FILE ID" for each, to pass the ids to
// ask_person. hh-attach --task 12 FILE... puts files of any kind on task 12 under their own names instead, for people to
// download on the task card and for any agent of the company to download with hh-fetch. hh-attach --chat FILE... attaches
// files to the agent's current chat reply (and Telegram reply when the turn answers Telegram); --task 12 and --chat may be
// given together. The node puts the address and the turn's token into HH_ATTACH_URL and HH_ATTACH_PASS for each turn.
'use strict';
const { openAsBlob } = require('node:fs');
const { basename } = require('node:path');

const USAGE =
  'Usage: hh-attach FILE... (PNG, JPEG or WebP, up to 3 MB each), hh-attach --task 12 FILE..., hh-attach --chat FILE..., or hh-attach --task 12 --chat FILE... (any file; one over 50 MB lives 30 days on one machine)';

function parseArgs(args) {
  let task;
  let chat = false;
  let i = 0;
  while (i < args.length) {
    if (args[i] === '--task') {
      task = args[i + 1];
      if (!task || task.startsWith('--')) return null;
      i += 2;
    } else if (args[i] === '--chat') {
      chat = true;
      i += 1;
    } else break;
  }
  const files = args.slice(i);
  return files.length ? { task, chat, files } : null;
}

async function main() {
  const url = process.env.HH_ATTACH_URL;
  const pass = process.env.HH_ATTACH_PASS;
  const parsed = parseArgs(process.argv.slice(2));
  if (!url || !pass) throw new Error('hh-attach works only inside a Hornhoof turn.');
  if (!parsed) throw new Error(USAGE);
  const { task, chat, files } = parsed;
  for (const file of files) {
    /* Read as it goes, so a file of any size passes. */
    let bytes;
    try {
      bytes = await openAsBlob(file);
    } catch {
      throw new Error(`Cannot read ${file}.`);
    }
    const query = new URLSearchParams();
    if (task) query.set('task', task.replace(/^#/, ''));
    if (chat) query.set('chat', '1');
    if (task || chat) query.set('name', basename(file));
    const to = query.size ? `${url}?${query}` : url;
    const res = await fetch(to, { method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/octet-stream' }, body: bytes });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) throw new Error(`${file}: ${(body.error && body.error.message) || `Hornhoof answered ${res.status}.`}`);
    process.stdout.write(`${file} ${body.id}\n`);
  }
}

/* Run as a command it attaches; required, as its tests do, it only lends its reading of the arguments. */
if (require.main === module) {
  main().catch(err => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs };
