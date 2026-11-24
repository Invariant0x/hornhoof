'use strict';

const { randomUUID } = require('node:crypto');
/* What comes only once, as a start, a prompt, a stop or an end, waits up to fifty seconds in all for a busy node to check
   who sends it: one the node checks after its caller gave up is refused. A tool's hooks hold up their tool and wait ten;
   a status line, which the next one replaces, three. None waits as long as the program running it lets it run, which
   the node tells it in HH_HOOK_LIMITS: milliseconds by event, with '*' for the rest. */
const ONCE = new Set(['start', 'prompt', 'stop', 'interrupt', 'end', 'ask', 'queued', 'invocation']);
const WAIT_MS = new Map([['tool', 10000], ['tooldone', 10000], ['toolfail', 10000]]);
const ONCE_MS = 50000;
const OTHER_MS = 3000;

function limitOf(event) {
  try {
    const limits = JSON.parse(process.env.HH_HOOK_LIMITS ?? '');
    const own = key => (limits && Object.hasOwn(limits, key) ? Number(limits[key]) : NaN);
    return Number.isNaN(own(event)) ? own('*') : own(event);
  } catch {
    return NaN;
  }
}

function waitOf(event) {
  const wanted = ONCE.has(event) ? ONCE_MS : (WAIT_MS.get(event) ?? OTHER_MS);
  const limit = limitOf(event);
  return limit > 0 ? Math.min(wanted, Math.floor((limit * 5) / 6)) : wanted;
}

class HookResponseError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}

async function post(url, event, body, call, signal) {
  const res = await fetch(`${url}/${event}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hh-pid': String(process.pid), 'x-hh-call': call },
    body,
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new HookResponseError(res.status);
  }
  return res;
}

/* A call out of time is not sent again: on a new connection its check would start over. */
const retryable = error => (error instanceof HookResponseError ? error.status >= 500 : error.name !== 'TimeoutError');
const reason = error => error instanceof HookResponseError ? error.message : error.name === 'TimeoutError' ? 'timeout' : 'connection lost';

/* A retry keeps the call id and the one wait: the bridge may have accepted the first call even when its answer never
   reached us. */
async function sendHook(event, body) {
  const url = process.env.HH_BRIDGE;
  if (!url) return null;
  const call = randomUUID();
  const signal = AbortSignal.timeout(waitOf(event));
  const tries = ONCE.has(event) ? 3 : 1;
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await post(url, event, body, call, signal);
    } catch (error) {
      last = error;
      if (!retryable(error)) break;
    }
  }
  await new Promise(resolve => process.stderr.write(`Hook ${event} delivery not confirmed: ${reason(last)}.\n`, resolve));
  return null;
}

module.exports = { sendHook };
