import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exitCodeOf } from './judge.mjs';
import { decodePlan, encodePlan, PLAN_CHARS } from './plan.mjs';
import { allUnavailable } from './stages.mjs';

const COMMIT = /^[a-f0-9]{40}$/;
const USAGE = 'Usage: npm run -s check:author -- --sha <40 hex> --base <40 hex> [--plan <text>] [--allow-whole]';
const OUTPUT_KEPT = 4 * 1024 * 1024;
const GIT_BYTES = 64 * 1024 * 1024;

export function parseArgs(argv) {
  const found = { sha: null, base: null, plan: null, allowWhole: false };
  const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === '--allow-whole') { found.allowWhole = true; continue; }
    const name = flag.slice(2);
    if (!['--sha', '--base', '--plan'].includes(flag) || !rest.length) return null;
    found[name] = rest.shift();
  }
  return COMMIT.test(found.sha ?? '') && COMMIT.test(found.base ?? '') ? found : null;
}

function run(program, args, cwd, write) {
  write(`$ ${[program, ...args].join(' ')}\n`);
  return new Promise(done => {
    let output = '';
    const take = chunk => {
      const text = chunk.toString();
      write(text);
      output = (output + text).slice(-OUTPUT_KEPT);
    };
    const child = spawn(program, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', () => done({ code: null, output }));
    child.on('close', code => done({ code: code ?? 1, output }));
  });
}

export function realPorts(root, write = text => process.stdout.write(text)) {
  const at = path => resolve(root, path);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: GIT_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
  const quietly = (work, otherwise) => { try { return work(); } catch { return otherwise; } };
  return {
    git,
    log: line => write(`${line}\n`),
    head: () => git(['rev-parse', 'HEAD']).trim(),
    hasCommit: sha => quietly(() => git(['cat-file', '-e', `${sha}^{commit}`]) === '', false),
    exists: path => existsSync(at(path)),
    read: path => quietly(() => readFileSync(at(path), 'utf8'), null),
    mkdir: path => mkdirSync(at(path), { recursive: true }),
    exec: (program, args, options) => run(program, args, at(options.cwd), write),
  };
}

function outsideRun(args, ports) {
  let plan;
  try { plan = ports.makePlan(args); }
  catch (error) { ports.log(`plan_failed: ${error.message}`); return 2; }
  const text = encodePlan(plan);
  if (text.length > PLAN_CHARS) { ports.log(`plan_too_long: ${text.length} characters, at most ${PLAN_CHARS}. A run cannot read the base of a change this large.`); return 2; }
  ports.log(`Nothing was checked here. Run this line through run_tests, on the branch at ${args.sha}:`);
  ports.log(`npm run -s check:author -- --sha ${args.sha} --base ${args.base} --plan ${text}${args.allowWhole ? ' --allow-whole' : ''}`);
  return 0;
}

function refuse(args, reason, paths, ports) {
  const result = allUnavailable(args.sha, reason, paths, ports.log);
  ports.log(`AUTHOR_CHECK ${JSON.stringify(result.record)}`);
  return exitCodeOf(result.stages);
}

function givenPlan(args) {
  const plan = decodePlan(args.plan);
  if (plan.sha !== args.sha || plan.base !== args.base) throw new Error('plan_invalid');
  return plan;
}

function planOnRun(args, ports) {
  try {
    if (args.plan) return { plan: givenPlan(args) };
    return ports.hasCommit(args.base) ? { plan: ports.makePlan(args) } : { reason: 'base_unreachable' };
  } catch { return { reason: args.plan ? 'plan_invalid' : 'plan_failed' }; }
}

async function onRun(args, ports) {
  if (ports.head() !== args.sha) return refuse(args, 'sha_mismatch', [], ports);
  const { plan, reason } = planOnRun(args, ports);
  if (!plan) return refuse(args, reason, [], ports);
  const failed = await ports.prepare();
  if (failed) return refuse(args, failed, plan.changes.map(change => change.path), ports);
  return (await ports.check(args, plan)).code;
}

/* The check runs only where run_tests puts it: that sets HH_TEST_PART. Anywhere else the same command prepares that line. */
export async function main(argv, env, ports) {
  const args = parseArgs(argv);
  if (!args) { ports.log(USAGE); return 2; }
  return env.HH_TEST_PART ? onRun(args, ports) : outsideRun(args, ports);
}
