import type { FastifyInstance } from 'fastify';
import { onTestFinished, vi, type TestContext } from 'vitest';
import { until as stateUntil } from './helpers-basic.js';

type Step = () => void | Promise<void>;
let steps: Set<Step> | null = null;
let signal: AbortSignal | undefined;
const apps = new Map<string, FastifyInstance>();

/* Wall time moves only between completed rounds. Deadline timers never elapse while an app, socket or file answers. */
export function controlledTime(context?: Pick<TestContext, 'signal'>): void {
  steps = new Set();
  signal = context?.signal;
  apps.clear();
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms).unref();
    return controller.signal;
  });
  onTestFinished(() => { steps = null; apps.clear(); timeout.mockRestore(); vi.useRealTimers(); });
}

export const manualTime = (): boolean => steps !== null;

export function registerStep(step: Step): () => void {
  steps?.add(step);
  return () => { steps?.delete(step); };
}

export function appAt(port: number, app: FastifyInstance): void {
  apps.set(`http://127.0.0.1:${port}`, app);
}

/* Run our actual HTTP route, without a fetch implementation's native connect and header deadlines. */
export const fetchApp: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const app = apps.get(url.origin);
  if (!app) throw new Error(`No test app at ${url.origin}.`);
  const method = request.method;
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') throw new Error(`Unexpected keeper method ${method}.`);
  const payload = method === 'GET' ? undefined : Buffer.from(await request.arrayBuffer());
  const res = await app.inject({ method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers), payload });
  return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode });
};

export async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const running = signal;
  await stateUntil(async () => {
    running?.throwIfAborted();
    vi.setSystemTime(Date.now() + 1);
    for (const step of [...(steps ?? [])]) await step();
    return check();
  });
}
