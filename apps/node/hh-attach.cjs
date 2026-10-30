#!/usr/bin/env node
// hh-attach FILE...: sends pictures from an agent's turn to Hornhoof and prints "FILE ID" for each, to pass the ids to
// ask_person. The node puts the address and the turn's token into HH_ATTACH_URL and HH_ATTACH_PASS for each turn.
'use strict';
const { readFileSync } = require('node:fs');

async function main() {
  const url = process.env.HH_ATTACH_URL;
  const pass = process.env.HH_ATTACH_PASS;
  const files = process.argv.slice(2);
  if (!url || !pass) throw new Error('hh-attach works only inside a Hornhoof turn.');
  if (!files.length) throw new Error('Usage: hh-attach FILE... (PNG, JPEG or WebP, up to 3 MB each)');
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(file);
    } catch {
      throw new Error(`Cannot read ${file}.`);
    }
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/octet-stream' }, body: bytes });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.id) throw new Error(`${file}: ${(body.error && body.error.message) || `Hornhoof answered ${res.status}.`}`);
    process.stdout.write(`${file} ${body.id}\n`);
  }
}

main().catch(err => {
  process.stderr.write(`${err.message}\n`);
  process.exit(1);
});
