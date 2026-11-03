import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProgramUpdates, readInstalledVersion } from '../src/program-updates.js';
import { done, FAKE, hasTmux, home, host, job, setUp, typeTurn, until } from './terminal-host-helpers.js';

type Launch = { version: string; pid: number; args: string[] };
const tools = join(home, 'version-tools');
const bin = join(tools, 'bin', 'claude.mjs');
const record = join(tools, 'launches.jsonl');
const launches = (): Launch[] => existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];

function install(version: string): void {
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(record)}, JSON.stringify({version:${JSON.stringify(version)},pid:process.pid,args:process.argv.slice(2)})+'\\n');\nawait import(${JSON.stringify(pathToFileURL(FAKE).href)});\n`, { mode: 0o755 });
  const file = join(tools, 'lib/node_modules/@anthropic-ai/claude-code/package.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version }));
}

describe.skipIf(!hasTmux)('installed versions between terminal turns', () => {
  afterEach(async () => host?.stop());

  it('finishes the active process and resumes a queued turn on the new version', async () => {
    install('1.0.0');
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'), install: async () => install('2.0.0') }]);
    const version = async () => { await updates.ready(); return updates.version('claude'); };
    await setUp();
    const old = host.run({ ...job('versioned', 'TICK old program'), bin, version });
    await until(async () => (await host.screen('versioned')).includes('Working'));
    const first = launches()[0]!;
    const sessionId = first.args[first.args.indexOf('--session-id') + 1]!;
    const next = host.run({ ...job('versioned', 'new program', { sessionId }), bin, version });
    await updates.update();
    expect(launches()).toHaveLength(1);
    expect(() => process.kill(first.pid, 0)).not.toThrow();
    expect(await old).toMatchObject({ ok: true, sessionId, result: 'echo: TICK old program' });
    expect(await next).toMatchObject({ ok: true, sessionId, result: 'echo: new program' });
    expect(launches()).toHaveLength(2);
    const second = launches()[1]!;
    expect(second.version).toBe('2.0.0');
    expect(second.pid).not.toBe(first.pid);
    expect(second.args).toEqual(expect.arrayContaining(['--resume', sessionId]));
    expect(await host.run({ ...job('versioned', 'same version', { sessionId }), bin, version })).toMatchObject({ ok: true, result: 'echo: same version' });
    expect(launches()).toHaveLength(2);
  });

  it('waits for the installed version before launching a new turn', async () => {
    install('1.0.0');
    const before = launches().length;
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const asked = new Promise<void>(resolve => { requested = resolve; });
    await setUp();
    const done = host.run({ ...job('waiting-version', 'after update'), bin, version: async () => { requested(); await pending; return '1.0.0'; } });
    try {
      expect(await Promise.race([asked.then(() => 'version requested'), done.then(() => 'finished')])).toBe('version requested');
      expect(launches()).toHaveLength(before);
    } finally {
      release();
    }
    expect(await done).toMatchObject({ ok: true, result: 'echo: after update' });
  });

  it('does not launch or wait for npm when a pending turn is cancelled', async () => {
    install('1.0.0');
    const before = launches().length;
    const stop = new AbortController();
    let release!: () => void;
    let requested!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const asked = new Promise<void>(resolve => { requested = resolve; });
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => '1.0.0', install: () => pending }]);
    const batch = updates.update();
    await setUp();
    let completed = false;
    const done = host.run({ ...job('cancel-version', 'Do not send this.', { signal: stop.signal }), bin,
      version: async () => { requested(); await updates.ready(stop.signal); return updates.version('claude'); } }).then(result => { completed = true; return result; });
    try {
      await asked;
      stop.abort();
      await until(() => completed, 1000);
      expect(await done).toMatchObject({ ok: false, error: 'cancelled' });
      expect(launches()).toHaveLength(before);
      expect(updates.snapshot()[0]?.updating).toBe(true);
    } finally {
      release();
      await batch;
      await done;
    }
  });

  it.each(['1.0.0', '2.0.0'])('lets a typed turn that began during an update finish before using version %s', async target => {
    install('1.0.0');
    let release!: () => void;
    let requested: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const updates = new ProgramUpdates([{ id: 'claude', readVersion: () => readInstalledVersion(tools, 'claude'),
      install: async () => { await pending; install(target); } }]);
    await setUp();
    const version = async () => { requested?.(); await updates.ready(); return updates.version('claude'); };
    const first = await host.run({ ...job('typed-version', 'warm up'), bin, version });
    const asked = new Promise<void>(resolve => { requested = resolve; });
    const updating = updates.update();
    const next = host.run({ ...job('typed-version', 'queued after update', { sessionId: first.sessionId }), bin, version });
    await asked;
    try {
      await typeTurn('typed-version', 'typed-version-view', 'TICK during update', 'typed-version-job');
      await until(async () => (await host.screen('typed-version')).includes('Working'));
    } finally {
      release();
    }
    await updating;
    expect(await next).toMatchObject({ ok: true, result: 'echo: queued after update' });
    expect(done('typed-version-job')).toMatchObject({ ok: true, result: 'echo: TICK during update' });
  });
});
