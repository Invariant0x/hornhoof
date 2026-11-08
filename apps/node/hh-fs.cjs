/* File work in agents' folders for a node that runs as root, done as the agents' own user: the node never follows a link
   an agent left there into its own files. One request per line on stdin, one answer per line on stdout. */
const { closeSync, constants, cpSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs');
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
  /* What is at the path as this user sees it, links followed: a file, a folder, or nothing it can reach. */
  kind: ({ path }) => {
    try {
      return statSync(path).isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  },
  /* What stands at the path itself, a link not followed: a plain file, a folder, a link, anything else, or nothing. */
  entry: ({ path }) => {
    try {
      const stat = lstatSync(path);
      return stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
    } catch (err) {
      if (err && ['ENOENT', 'ENOTDIR'].includes(err.code)) return null;
      throw err;
    }
  },
  /* A plain file at the path itself: never through a link, and never waiting on a pipe or a device. */
  readPlain: ({ path }) => {
    let fd;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      if (err && err.code === 'ELOOP') throw new Error(`${path} is a link, not a plain file.`);
      throw err;
    }
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`${path} is not a plain file.`);
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  },
  /* Written whole and moved into place, so a program reading it at the same moment sees the old file or the new one. */
  write: ({ path, data }) => {
    const temp = `${path}.hh-${process.pid}`;
    writeFileSync(temp, data, { mode: 0o600 });
    renameSync(temp, path);
  },
  /* A link goes, not what it points at. */
  remove: ({ path }) => void rmSync(path, { recursive: true, force: true }),
  /* From a folder of the node's own, such as one in the image, with its files' modes. */
  copy: ({ path, from }) => {
    if (typeof from !== 'string') throw new Error('copy needs from.');
    cpSync(from, path, { recursive: true });
  },
  /* Whole, its links as they are, and never over anything already there, a link that leads nowhere included. */
  move: ({ path, from }) => {
    if (typeof from !== 'string') throw new Error('move needs from.');
    let there = true;
    try {
      lstatSync(path);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
      there = false;
    }
    if (there) throw new Error(`${path} is there already, so nothing was moved over it.`);
    renameSync(from, path);
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
