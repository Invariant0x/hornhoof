import { spawn } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provedBase } from './github-tests/base.mjs';
import { changesSince } from './github-tests/changes.mjs';
import { git, proved } from './github-tests/marks.mjs';
import { invocationsOf, lintCommands, outputsOf, runAll } from './github-tests/parts.mjs';

/* The tests of .github/workflows/images.yml for a commit no mark proved. Without arguments, the first job chooses them: the
   tests the change since a commit whose tests passed reaches, or the whole suite whenever it cannot tell. --lint runs the lint
   of the first part, and --run N the tests of part N, both of the choice in SELECTION. */

const env = process.env;
const root = process.cwd();
const say = text => process.stdout.write(`${text}\n`);

function exec(command, extra = {}) {
  say(`$ ${[command.program, ...command.args].join(' ')}`);
  return new Promise(done => {
    const child = spawn(command.program, command.args, { cwd: join(root, command.cwd), env: { ...env, ...extra }, stdio: 'inherit' });
    child.on('error', () => done(1));
    child.on('close', code => done(code ?? 1));
  });
}

async function choose() {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const found = await provedBase({ name: env.GITHUB_EVENT_NAME, event, sha: env.GITHUB_SHA, full: env.FULL_RUN === 'true' }, { git, proved: async sha => (await proved(sha)).proved });
  say(found.why);
  if (!found.base) return null;
  const { changes, moved } = changesSince(found.base, env.GITHUB_SHA, git);
  for (const path of moved) say(`NOTE only our own versions moved: ${path}`);
  const { chooseTests } = await import('./github-tests/choose.mjs');
  const chosen = await chooseTests(found.base, changes, root);
  for (const note of chosen.notes) say(`NOTE ${note}`);
  say(chosen.why);
  return chosen.plan;
}

const plan = () => (env.SELECTION ? JSON.parse(env.SELECTION) : null);

async function lint() {
  const commands = lintCommands(plan());
  if (!commands.length) say('The change left no file to lint.');
  return runAll(commands.map(command => ({ command, env: {} })), exec);
}

async function run(number) {
  const chosen = plan(), part = chosen?.parts[Number(number) - 1];
  if (!part) throw new Error(`The selection has no part ${number}`);
  const { parseTestEnvironment } = await import('@hornhoof/protocol');
  const { buildTestInvocation } = await import('../apps/node/dist/test-environment.js');
  const { suites } = parseTestEnvironment(readFileSync(join(root, '.hornhoof/test-environment.json'), 'utf8'));
  const invocations = await invocationsOf(part, suites, { root, dir: mkdtempSync(join(env.RUNNER_TEMP || tmpdir(), 'hh-tests-')) }, buildTestInvocation);
  if (!invocations.length) say(`Part ${number} runs no tests: the change since ${chosen.base} reaches none.`);
  return runAll(invocations, exec);
}

const [mode, value] = process.argv.slice(2);
if (mode === '--lint' || mode === '--run') {
  process.exitCode = await (mode === '--lint' ? lint() : run(value)).catch(error => { process.stderr.write(`${error.message}.\n`); return 2; });
} else {
  const chosen = await choose().catch(error => { say(`Could not choose the tests: ${error.message}.`); return null; });
  if (!chosen) say('The whole suite runs, in four parts.');
  appendFileSync(env.GITHUB_OUTPUT, outputsOf(chosen));
}
