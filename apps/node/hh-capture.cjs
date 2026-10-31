/* A pane's raw output, bounded and written by one process. Open only the private files the host already made. */
const { spawnSync } = require('node:child_process');
const { closeSync, constants, openSync, rmSync, writeSync } = require('node:fs');

const [file, ready, bytes, socket, session] = process.argv.slice(2);
const limit = Number(bytes);
if (!file || !ready || !socket || !session || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid output capture arguments.');
const fd = openSync(file, constants.O_WRONLY | constants.O_NOFOLLOW);
const readyFd = openSync(ready, constants.O_WRONLY | constants.O_NOFOLLOW);
writeSync(readyFd, 'ready');
closeSync(readyFd);

let output = Buffer.alloc(0);
let closed = false;
process.stdin.on('data', chunk => {
  const next = Buffer.concat([output, chunk]);
  output = next.length > limit ? next.subarray(next.length - limit) : next;
  for (let at = 0; at < output.length;) at += writeSync(fd, output, at, output.length - at, at);
});

function close() {
  if (closed) return;
  closed = true;
  closeSync(fd);
  removeIfSessionEnded();
}

function removeIfSessionEnded() {
  /* A dead pane may still need its output. A removed session does not, including after the node restarted. */
  const status = spawnSync('tmux', ['-L', socket, 'has-session', '-t', `=${session}`], { stdio: 'ignore' }).status;
  if (status === 1) {
    rmSync(file, { force: true });
    rmSync(ready, { force: true });
  }
}
process.stdin.once('end', close);
for (const signal of ['SIGTERM', 'SIGHUP']) process.once(signal, () => { close(); process.exit(0); });
