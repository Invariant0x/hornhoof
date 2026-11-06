#!/usr/bin/env node
// Stands in for /usr/bin/git in the external Git tests: a real remote behind a controlled refusal. Every other call goes
// to real git, so what the remote holds afterwards is real evidence. plan.json names, per Git command, what its next
// calls do; log.ndjson records every call with the credential it was given. Only --version answers as the git of the
// node's image unless the plan says otherwise: from 2.48 on, as on GitHub's machines, a node leaves a configured fetch
// to plain git, and nothing else in these tests is about the git of the machine they run on.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.HH_FAKE_GIT_DIR;
const argv = process.argv.slice(2);

function commandOf(args) {
  let i = 0;
  while (args[i] === '-C' || args[i] === '-c') i += 2;
  return args[i] ?? null;
}

const NODE_GIT = { do: 'say', stdout: 'git version 2.39.5\n', exit: 0 };

function nextStep(command) {
  const otherwise = command === '--version' ? NODE_GIT : { do: 'real' };
  const file = join(dir, 'plan.json');
  if (!existsSync(file)) return otherwise;
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  const step = plan[command]?.shift();
  writeFileSync(file, JSON.stringify(plan));
  return step ?? otherwise;
}

const real = () => spawnSync('/usr/bin/git', argv, { stdio: 'inherit' }).status ?? 1;

function say(stderr, stdout) {
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

const STEPS = {
  real,
  /* The remote refused for a moment: nothing reached the branch. */
  refuse() {
    say('remote: fatal error in commit_refs_rules\nTo remote\n ! [remote rejected] task-1 -> task-1 (failure)\n');
    return 1;
  },
  /* The remote took the push and the answer got lost. */
  accept_then_hang() {
    real();
    say('fatal: the remote end hung up unexpectedly\n');
    return 128;
  },
  say(step) {
    say(step.stderr, step.stdout);
    return step.exit;
  },
  /* Ends by itself in the end, so that a test that could not stop it leaves nothing behind. */
  hang() {
    say('remote: still working\n');
    setTimeout(() => process.exit(0), 15_000);
    return null;
  },
  ignore_term() {
    process.on('SIGTERM', () => {});
    return STEPS.hang();
  },
  /* A process git started, such as a credential daemon, outlives it and keeps its pipes. */
  leave_process() {
    spawn('/bin/sleep', ['15'], { detached: true, stdio: 'inherit' }).unref();
    return real();
  },
};

const command = commandOf(argv);
appendFileSync(join(dir, 'log.ndjson'), `${JSON.stringify({ command, argv, token: process.env.HH_GIT_PASSWORD ?? null, nested: process.env.HH_GIT_NESTED ?? null })}\n`);
const step = nextStep(command);
const code = STEPS[step.do](step);
if (code !== null) process.exitCode = code;
