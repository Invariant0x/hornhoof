import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mock } from 'node:test';
import { TerminalHost } from '../apps/node/src/terminal/host.ts';
import { Tmux } from '../apps/node/src/terminal/tmux.ts';
import { kimiProgram } from '../apps/node/src/terminal/programs.ts';
import { SCREEN_SIGNED_OUT } from '../apps/node/src/providers/kimi.ts';

const evidence = dirname(fileURLToPath(import.meta.url));
const acceptText = "The program did not take Hornhoof's prompt within";
const sourceFiles = [
  'apps/node/src/terminal/host.ts',
  'apps/node/src/terminal/tmux.ts',
  'apps/node/src/terminal/transcripts.ts',
  'apps/node/src/terminal/programs.ts',
];
const sourceSha256 = Object.fromEntries(sourceFiles.map(file => [
  file,
  createHash('sha256').update(readFileSync(join(evidence, '..', file))).digest('hex'),
]));

async function advance(ms) {
  for (let done = 0; done < ms; done += 25) {
    mock.timers.tick(Math.min(25, ms - done));
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
  }
}

function makeCase(screen) {
  const root = mkdtempSync(join(evidence, 'sandbox-'));
  const home = join(root, 'home');
  const workDir = join(root, 'work');
  const wire = join(home, 'sessions', 'fixture-workspace', 'fixture-session', 'agents', 'main', 'wire.jsonl');
  mkdirSync(dirname(wire), { recursive: true });
  writeFileSync(wire, '');
  const pane = { dead: false, screen, calls: [] };
  const tmux = new Tmux({ socket: 'fixture-only', env: { PATH: 'fixture' } });
  tmux.run = async (args, input) => {
    pane.calls.push({ args: [...args], inputBytes: input ? Buffer.byteLength(input) : 0 });
    if (args[0] === 'display-message' && args.includes('#{pane_dead}')) return pane.dead ? '1\n' : '0\n';
    if (args[0] === 'capture-pane') return pane.screen;
    return '';
  };
  const host = new TerminalHost({
    tmux,
    hornhoof: 'http://127.0.0.1:9',
    send: () => {},
    secrets: () => [],
    readyMs: 2000,
    pollMs: 25,
    enterWaitMs: 100,
    toolsMs: 100,
  });
  const job = {
    key: 'fixture',
    program: kimiProgram,
    bin: '/fixture/kimi',
    home,
    signedOut: SCREEN_SIGNED_OUT,
    input: {
      agentKey: 'fixture',
      prompt: 'synthetic prompt',
      sessionId: 'fixture-session',
      model: null,
      effort: null,
      compactWindow: null,
      workDir,
      secret: null,
      timeoutMs: 60_000,
      instructions: null,
      context: null,
      guidance: null,
      tools: null,
    },
  };
  return { root, wire, pane, tmux, host, job };
}

function observations(testCase, result, tookBeforeDead = false) {
  const calls = testCase.pane.calls;
  return {
    ok: result.ok,
    error: result.error,
    output: result.output,
    acceptDiagnostic: result.output.includes(acceptText),
    launchCount: calls.filter(call => call.args.includes('new-session') || call.args.includes('respawn-pane')).length,
    promptPasteCount: calls.filter(call => call.args[0] === 'paste-buffer').length,
    enterCount: calls.filter(call => call.args[0] === 'send-keys' && call.args.includes('Enter')).length,
    paneProbeCount: calls.filter(call => call.args[0] === 'display-message' && call.args.includes('#{pane_dead}')).length,
    tookBeforeDead,
    paneDead: testCase.pane.dead,
  };
}

async function readyWait() {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.UTC(2026, 10, 1) });
  const testCase = makeCase('starting without a READY footer');
  try {
    const turn = testCase.host.run(testCase.job);
    await advance(2100);
    const result = await turn;
    const observed = observations(testCase, result);
    assert.equal(observed.error, 'agent_failed');
    assert.equal(observed.paneDead, false);
    assert.equal(observed.launchCount, 1);
    assert.equal(observed.promptPasteCount, 0);
    assert.equal(observed.enterCount, 0);
    assert.equal(observed.acceptDiagnostic, false);
    assert.ok(observed.paneProbeCount > 0);
    assert.equal(await testCase.tmux.alive('a-fixture'), true);
    return { name: 'READY wait, live pane, no prompt sent', ...observed };
  } finally {
    await testCase.host.stop();
    mock.timers.reset();
    rmSync(testCase.root, { recursive: true, force: true });
  }
}

async function acceptWait() {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.UTC(2026, 10, 1) });
  const testCase = makeCase('context: 42%');
  try {
    const turn = testCase.host.run(testCase.job);
    await advance(3500);
    const result = await turn;
    const observed = observations(testCase, result);
    assert.equal(observed.error, 'agent_failed');
    assert.equal(observed.paneDead, false);
    assert.equal(observed.promptPasteCount, 1);
    assert.ok(observed.enterCount >= 2);
    assert.equal(observed.acceptDiagnostic, true);
    assert.equal(await testCase.tmux.alive('a-fixture'), true);
    return { name: 'prompt accept wait, live pane, no wire start', ...observed };
  } finally {
    await testCase.host.stop();
    mock.timers.reset();
    rmSync(testCase.root, { recursive: true, force: true });
  }
}

async function deadPane() {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.UTC(2026, 10, 1) });
  const testCase = makeCase('context: 42%');
  try {
    const turn = testCase.host.run(testCase.job);
    await advance(900);
    appendFileSync(testCase.wire, `${JSON.stringify({ type: 'turn.prompt' })}\n`);
    await advance(300);
    const tookBeforeDead = testCase.host.agents.get('fixture')?.took === true;
    assert.equal(tookBeforeDead, true);
    testCase.pane.dead = true;
    await advance(100);
    const result = await turn;
    const observed = observations(testCase, result, tookBeforeDead);
    assert.equal(observed.error, 'agent_failed');
    assert.equal(observed.paneDead, true);
    assert.equal(observed.promptPasteCount, 1);
    assert.equal(observed.tookBeforeDead, true);
    assert.equal(observed.acceptDiagnostic, false);
    assert.equal(await testCase.tmux.alive('a-fixture'), false);
    return { name: 'done loop, wire prompt accepted, pane_dead=1', ...observed };
  } finally {
    await testCase.host.stop();
    mock.timers.reset();
    rmSync(testCase.root, { recursive: true, force: true });
  }
}

const scenarios = [await readyWait(), await acceptWait(), await deadPane()];
const output = {
  sourceCommit: 'bd696b0724385b6b11da53a24ada2f188b031217',
  sourceSha256,
  clock: 'node:test mock.timers Date/setTimeout/setInterval',
  pane: 'actual Tmux methods with isolated run() stub returning pane_dead and screen values',
  wire: 'actual LineTail/findKimiWire with one synthetic turn.prompt record',
  modelCalls: 0,
  networkCalls: 0,
  realTmux: false,
  historicalReproduction: false,
  scenarios,
};
writeFileSync(join(evidence, 'phase-fixture-output.json'), `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify(output, null, 2));
console.log('PHASE_FIXTURE_PASS scenarios=3 READY_ACCEPT_DEAD_PANE_DISTINCT modelCalls=0 networkCalls=0');
