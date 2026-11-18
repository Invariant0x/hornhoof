/* From the repository root on macOS: npm run build -w apps/node && node apps/node/test/probes/mac-hook-owner.mjs */
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../../dist/terminal/bridge.js';
import { terminalOwner } from '../../dist/main.js';
import { answered } from '../../dist/terminal/mac-peer.js';

/* The node's own lookup commands, timed: how long lsof and ps take on this Mac is what a hook waits for. */
const took = { lsof: [], ps: [] };
function timed(file, args, options) {
  const started = performance.now();
  return new Promise((resolve, reject) => execFile(file, args, options, (error, output) => {
    took[file.endsWith('lsof') ? 'lsof' : 'ps'].push(performance.now() - started);
    try { resolve(answered(error, output)); } catch (failed) { reject(failed); }
  }));
}
const slowest = times => `${Math.round(Math.max(...times))} ms`;

function send(url) {
  return new Promise((resolve, reject) => {
    const call = request(url + '/stop', { method: 'POST', agent: false, headers: { 'x-hh-pid': String(process.pid) } }, res => {
      res.resume().on('end', () => resolve(res.statusCode));
    });
    call.on('error', reject).end('{}');
  });
}

function worker() {
  process.on('message', async url => {
    try { process.send({ status: await send(url) }); }
    catch (error) { process.send({ error: String(error) }); }
  });
  process.send('ready');
}

async function child() {
  const spawned = spawn(process.execPath, [fileURLToPath(import.meta.url), 'worker'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  await once(spawned, 'message');
  return spawned;
}

async function call(child, url) {
  const result = once(child, 'message');
  child.send(url);
  const [reply] = await result;
  assert.equal(reply.error, undefined, 'the hook client failed');
  return reply.status;
}

async function main() {
  assert.equal(process.platform, 'darwin', 'Run this probe on a real Mac.');
  const own = await child();
  const foreign = await child();
  const owner = terminalOwner('darwin', timed)(async () => [own.pid]);
  const rejected = [];
  const bridge = new Bridge('http://127.0.0.1:9', () => {}, owner.owns, { capture: owner.capture, rejected: (_key, _event, reason) => rejected.push(reason) });
  try {
    await bridge.start();
    const url = bridge.agent('probe').hookUrl;
    for (let n = 0; n < 20; n++) assert.equal(await call(own, url), 200, 'own agent hook must be accepted');
    assert.equal(await call(foreign, url), 403, 'foreign process hook must be rejected');
    assert.equal(took.lsof.length, 21, 'every connection must run its own lookup');
    assert.deepEqual(rejected, ["owner check failed: the caller is not under the agent's pane"]);
    console.log(`Own hooks: 20/20 accepted. Foreign hook: 403, refused as not under the pane. Every connection ran its own lsof lookup; slowest lsof ${slowest(took.lsof)}, slowest ps ${slowest(took.ps)}.`);
  } finally {
    bridge.stop();
    own.kill();
    foreign.kill();
  }
}

if (process.argv[2] === 'worker') worker();
else await main();
