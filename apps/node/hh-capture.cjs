/* A pane's raw output, bounded and written by one process. Open only the private files the host already made. */
const { spawnSync } = require('node:child_process');
const { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, rmSync, writeSync } = require('node:fs');

/* Keeps at least the last limit bytes at the end of the file. A program redraws its screen many times a second, so each
   chunk is appended, and the file is cut back to its last limit bytes only once it holds twice that. */
function tail(fd, limit, io = { write: writeSync, truncate: ftruncateSync }) {
  const kept = [];
  let keptBytes = 0;
  let size = 0;
  let end = 0;
  let generation = 0;
  const publish = () => io.publish?.({ generation: ++generation, end, size });
  const writeAll = (data, at) => {
    for (let done = 0; done < data.length;) done += io.write(fd, data, done, data.length - done, at + done);
  };
  const append = chunk => {
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
  const keep = chunk => {
    publish();
    append(chunk);
    end += chunk.length;
    publish();
  };
  /* Once the program is over the file holds no more than the limit. */
  keep.end = () => {
    if (size <= limit) return;
    publish();
    const last = Buffer.concat(kept);
    const cut = last.subarray(Math.max(0, last.length - limit));
    io.truncate(fd, 0);
    writeAll(cut, 0);
    size = cut.length;
    publish();
  };
  return keep;
}

if (require.main === module) record();

function captureArguments(args) {
  const [file, ready, flush, bytes, socket, session, position] = args;
  const limit = Number(bytes);
  if (!file || !ready || !flush || !socket || !session || !position || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid output capture arguments.');
  return { file, ready, flush, limit, socket, session, position };
}

function positionPublisher(fd) {
  return ({ generation, end, size }) => {
    const data = Buffer.alloc(24);
    data.writeDoubleBE(generation, 0);
    data.writeDoubleBE(end, 8);
    data.writeDoubleBE(size, 16);
    /* Mark a write before its bytes change; publish its even generation only after both bounds are complete. */
    const parts = generation % 2 ? [[0, 8], [8, 16]] : [[8, 16], [0, 8]];
    for (const [at, length] of parts) {
      for (let done = 0; done < length;) done += writeSync(fd, data, at + done, length - done, at + done);
    }
  };
}

function record() {
const { file, ready, flush, limit, socket, session, position } = captureArguments(process.argv.slice(2));
const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
const readyFd = openSync(ready, constants.O_WRONLY | constants.O_NOFOLLOW);
const positionFd = openSync(position, constants.O_WRONLY | constants.O_NOFOLLOW);
const publish = positionPublisher(positionFd);
publish({ generation: 0, end: 0, size: 0 });
const keep = tail(fd, limit, { write: writeSync, truncate: ftruncateSync, publish });
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
  closeSync(positionFd);
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
  closeSync(positionFd);
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
    rmSync(position, { force: true });
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
