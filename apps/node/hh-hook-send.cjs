'use strict';

const { randomUUID } = require('node:crypto');
/* A start, a stop and an interrupt each come once and tell what nothing else does: a busy node may take long to check who
   sends them, so they wait and try again, and a call it checks after its caller gave up is refused. A tool's hooks hold
   up its tool and go once, but wait as long as the rest for a busy node to check who sends them. */
const WAIT_MS = { prompt: 12000, start: 15000, stop: 15000, interrupt: 15000, tool: 3000, tooldone: 3000, toolfail: 3000 };
const ONCE = new Set(['start', 'stop', 'interrupt']);

class HookResponseError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function post(url, event, body, call) {
  const res = await fetch(`${url}/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hh-pid': String(process.pid), 'x-hh-call': call },
    body,
    signal: AbortSignal.timeout(WAIT_MS[event] ?? 3000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HookResponseError(res.status);
  }
  return res;
}

const retryable = error => !(error instanceof HookResponseError) || error.status >= 500;
const reason = error => error instanceof HookResponseError ? error.message : error.name === 'TimeoutError' ? 'timeout' : 'connection lost';

/* A retry keeps the call id: the bridge may have accepted the first call even when its answer never reached us. */
async function sendHook(event, body) {
  const url = process.env.HH_BRIDGE;
  if (!url) return null;
  const call = randomUUID();
  const tries = ONCE.has(event) ? 3 : 1;
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await post(url, event, body, call);
    } catch (error) {
      last = error;
      if (!retryable(error)) break;
    }
  }
  await new Promise(resolve => process.stderr.write(`Hook ${event} delivery not confirmed: ${reason(last)}.\n`, resolve));
  return null;
}

module.exports = { sendHook };
