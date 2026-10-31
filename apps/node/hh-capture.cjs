/* A pane's raw output, bounded and written by one process. Open only the private files the host already made. */
const { spawnSync } = require('node:child_process');
const { closeSync, constants, fstatSync, openSync, readSync, rmSync, writeSync } = require('node:fs');

const [file, ready, flush, bytes, socket, session] = process.argv.slice(2);
const limit = Number(bytes);
if (!file || !ready || !flush || !socket || !session || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid output capture arguments.');
const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
const readyFd = openSync(ready, constants.O_WRONLY | constants.O_NOFOLLOW);

let output = Buffer.alloc(0);
let closed = false;
function keep(chunk) {
  const next = Buffer.concat([output, chunk]);
  output = next.length > limit ? next.subarray(next.length - limit) : next;
  for (let at = 0; at < output.length;) at += writeSync(fd, output, at, output.length - at, at);
}

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
