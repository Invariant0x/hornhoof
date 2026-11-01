/* File work in agents' folders for a node that runs as root, done as the agents' own user: the node never follows a link
   an agent left there into its own files. One request per line on stdin, one answer per line on stdout. */
const { mkdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
const { createInterface } = require('node:readline');

const OPS = {
  mkdir: ({ path }) => void mkdirSync(path, { recursive: true }),
  read: ({ path }) => {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  },
  /* Written whole and moved into place, so a program reading it at the same moment sees the old file or the new one. */
  write: ({ path, data }) => {
    const temp = `${path}.hh-${process.pid}`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  },
};

createInterface({ input: process.stdin }).on('line', line => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  let reply;
  try {
    if (!Object.hasOwn(OPS, msg.op) || typeof msg.path !== 'string') throw new Error(`Unknown request ${msg.op}.`);
    reply = { id: msg.id, ok: true, data: OPS[msg.op](msg) ?? null };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: String((err && err.message) || err) };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
});
