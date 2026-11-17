import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exitCodeOf } from './judge.mjs';
import { allUnavailable } from './stages.mjs';

const COMMIT = /^[a-f0-9]{40}$/;
const USAGE = 'Usage: npm run -s check:author -- --sha <40 hex> --base <40 hex> [--allow-whole]';
const OUTPUT_KEPT = 4 * 1024 * 1024;
const GIT_BYTES = 64 * 1024 * 1024;

export function parseArgs(argv) {
  const found = { sha: null, base: null, allowWhole: false };
  const rest = [...argv];
  while (rest.length) {
    const flag = rest.shift();
    if (flag === '--allow-whole') { found.allowWhole = true; continue; }
    const name = flag.slice(2);
    if (!['--sha', '--base'].includes(flag) || !rest.length) return null;
    found[name] = rest.shift();
  }
  return COMMIT.test(found.sha ?? '') && COMMIT.test(found.base ?? '') ? found : null;
}

function run(program, args, { cwd, env }, write) {
  write(`$ ${[program, ...args].join(' ')}\n`);
  return new Promise(done => {
    let output = '';
    const take = chunk => {
      const text = chunk.toString();
      write(text);
      output = (output + text).slice(-OUTPUT_KEPT);
    };
    const child = spawn(program, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    read: path => quietly(() => readFileSync(at(path), 'utf8'), null),
    mkdir: path => mkdirSync(at(path), { recursive: true }),
    write: (path, text) => writeFileSync(at(path), text),
    exec: (program, args, options) => run(program, args, { cwd: at(options.cwd), env: options.env }, write),
  };
}

function refuse(args, reason, paths, ports) {
  const result = allUnavailable(args.sha, reason, paths, ports.log);
  ports.log(`AUTHOR_CHECK ${JSON.stringify(result.record)}`);
  return exitCodeOf(result.stages);
}

function planOf(args, ports) {
  if (!ports.hasCommit(args.base)) return { reason: 'base_unreachable' };
  try { return { plan: ports.makePlan(args) }; } catch (error) { ports.log(`plan_failed: ${error.message}`); return { reason: 'plan_failed' }; }
}

async function checked(args, ports) {
  if (ports.head() !== args.sha) return refuse(args, 'sha_mismatch', [], ports);
  const { plan, reason } = planOf(args, ports);
  if (!plan) return refuse(args, reason, [], ports);
  const failed = await ports.prepare();
  if (failed) return refuse(args, failed, plan.changes.map(change => change.path), ports);
  return (await ports.check(args, plan)).code;
}

/* The check runs where it is called: in the workspace of whoever builds or reviews the change, at the commit asked for. */
export async function main(argv, ports) {
  const args = parseArgs(argv);
  if (!args) { ports.log(USAGE); return 2; }
  return checked(args, ports);
}
