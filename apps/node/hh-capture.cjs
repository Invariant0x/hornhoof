/* A pane's raw output, bounded and written by one process. Open only the private files the host already made. */
const { spawnSync } = require('node:child_process');
const { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, rmSync, writeSync } = require('node:fs');

/* Keeps at least the last limit bytes at the end of the file. A program redraws its screen many times a second, so each
   chunk is appended, and the file is cut back to its last limit bytes only once it holds twice that. */
function tail(fd, limit, io = { write: writeSync, truncate: ftruncateSync }) {
  const kept = [];
  let keptBytes = 0;
  let size = 0;
  const writeAll = (data, at) => {
    for (let done = 0; done < data.length;) done += io.write(fd, data, done, data.length - done, at + done);
  };
  const keep = chunk => {
    kept.push(chunk);
    keptBytes += chunk.length;
    while (kept.length > 1 && keptBytes - kept[0].length >= limit) keptBytes -= kept.shift().length;
    if (size + chunk.length <= 2 * limit) {
      writeAll(chunk, size);
      size += chunk.length;
      return;
    }
    const last = Buffer.concat(kept);
    const cut = last.subarray(Math.max(0, last.length - limit));
    io.truncate(fd, 0);
    writeAll(cut, 0);
    size = cut.length;
  };
  /* Once the program is over the file holds no more than the limit. */
  keep.end = () => {
    if (size <= limit) return;
    const last = Buffer.concat(kept);
    const cut = last.subarray(Math.max(0, last.length - limit));
    io.truncate(fd, 0);
    writeAll(cut, 0);
    size = cut.length;
  };
  return keep;
}

if (require.main === module) record();

function record() {
const [file, ready, flush, bytes, socket, session] = process.argv.slice(2);
const limit = Number(bytes);
if (!file || !ready || !flush || !socket || !session || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid output capture arguments.');
const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
const readyFd = openSync(ready, constants.O_WRONLY | constants.O_NOFOLLOW);

const keep = tail(fd, limit);
let closed = false;

function requested() {
  let control;
  try {
    control = openSync(flush, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(control).isFile()) return false;
    const buffer = Buffer.alloc(5);
    return readSync(control, buffer, 0, 5, 0) === 5 && buffer.toString() === 'flush';
  } catch {
    return false;
  } finally {
    if (control !== undefined) closeSync(control);
  }
}

/* tmux keeps the pipe open on a retained pane. Drain its already-emitted bytes explicitly before acknowledging. */
function drainKernel() {
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    let bytes;
    try { bytes = readSync(0, buffer, 0, buffer.length, null); }
    catch (error) {
      if (['EAGAIN', 'EWOULDBLOCK', 'EBADF'].includes(error.code)) return;
      throw error;
    }
    if (bytes === 0) return;
    keep(buffer.subarray(0, bytes));
  }
}

function finish() {
  if (closed) return;
  process.stdin.pause();
  process.stdin.removeListener('data', keep);
  for (let chunk; (chunk = process.stdin.read()) !== null;) keep(chunk);
  drainKernel();
  keep.end();
  closeSync(fd);
  writeSync(readyFd, 'ended', 0, 'utf8');
  closeSync(readyFd);
  closed = true;
  clearInterval(poll);
  process.stdin.destroy();
  removeIfSessionEnded();
}

function close() {
  if (closed) return;
  closed = true;
  clearInterval(poll);
  closeSync(fd);
  closeSync(readyFd);
  process.stdin.destroy();
  removeIfSessionEnded();
}

function removeIfSessionEnded() {
  /* A dead pane may still need its output. A removed session does not, including after the node restarted. */
  const status = spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${session}`], { stdio: 'ignore' }).status;
  if (status === 1) {
    rmSync(file, { force: true });
    rmSync(ready, { force: true });
    rmSync(flush, { force: true });
  }
}
process.stdin.on('data', keep);
process.stdin.once('end', finish);
const poll = setInterval(() => { if (requested()) finish(); }, 10);
poll.unref();
writeSync(readyFd, 'ready', 0, 'utf8');
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => { close(); process.exit(0); });
}

module.exports = { tail };
