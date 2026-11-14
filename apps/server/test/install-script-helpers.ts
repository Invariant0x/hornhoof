import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = fileURLToPath(new URL('../../../scripts/install.sh', import.meta.url));
const STUBS = fileURLToPath(new URL('./install-stubs/', import.meta.url));
export const SERVER = 'https://hornhoof.example.test';
export const IMAGE = 'ghcr.io/invariant0x/hornhoof-node:latest';
export const CODE = 'Ab3_d-Ef'.repeat(5) + 'xyz';
export const SUB_A = '1c07dac4-c52e-48b4-b316-81c19de61bd7';
export const SUB_B = '9f1e2d3c-0000-4000-8000-000000000002';
const TWO_LINES = `${SUB_A} claude node-key-aaaaaaaaaaaaaaaa\\n${SUB_B} codex node-key-bbbbbbbbbbbbbbbb\\n`;

/* System tools the script and the stubs may use. Real docker, brew, curl and sudo are never reachable. */
const TOOLS = ['bash', 'sh', 'env', 'cat', 'od', 'tr', 'head', 'base64', 'sleep', 'mkdir', 'rm', 'chmod', 'grep', 'sed', 'cut', 'cp', 'mv', 'touch', 'basename', 'dirname', 'wc', 'mktemp', 'date', 'sort', 'kill', 'printf', 'tail', 'awk', 'sha256sum', 'shasum', 'tee'];
/* The installer runs Docker's and Homebrew's install scripts only when their SHA-256 is the one it pins. */
const sha256 = (stub: string) => createHash('sha256').update(readFileSync(join(STUBS, stub))).digest('hex');

type Options = { script?: string; args?: string[]; omit?: string[]; env?: Record<string, string>; tty?: string };

export function install({ script = SCRIPT, args = ['--join', CODE], omit = [], env = {}, tty = 'typed-answer\n' }: Options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hh-install-'));
  const bin = join(dir, 'stubs');
  const sys = join(dir, 'sys');
  mkdirSync(bin);
  mkdirSync(sys);
  for (const f of readdirSync(STUBS)) if (!f.startsWith('_') && !omit.includes(f)) copyFileSync(join(STUBS, f), join(bin, f));
  for (const tool of TOOLS) {
    const real = ['/usr/bin', '/bin'].map(d => join(d, tool)).find(p => existsSync(p));
    if (real) symlinkSync(real, join(sys, tool));
  }
  const ttyFile = join(dir, 'tty');
  writeFileSync(ttyFile, tty);
  const log = join(dir, 'stub.log');
  writeFileSync(log, '');
  const res = spawnSync(join(sys, 'bash'), [script, ...args], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${sys}`,
      HOME: join(dir, 'home'),
      STUB_LOG: log,
      STUB_SRC: STUBS,
      STUB_BIN: bin,
      STUB_STATE: dir,
      HORNHOOF_SERVER: SERVER,
      HORNHOOF_TTY: ttyFile,
      HORNHOOF_HOME: join(dir, 'home', '.hornhoof'),
      HORNHOOF_DIR: join(dir, 'home', 'hornhoof'),
      STUB_JOIN_BODY: TWO_LINES,
      HORNHOOF_SIGNIN_WAIT: '0',
      HORNHOOF_DOCKER_SCRIPT_SHA256: sha256('_docker-install.sh'),
      HORNHOOF_BREW_SCRIPT_SHA256: sha256('_brew-install.sh'),
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { code: res.status, out: res.stdout + res.stderr, calls, dir, docker: calls.filter(c => /^(sudo )?docker /.test(c)) };
}

export const indexOf = (calls: string[], start: string) => calls.findIndex(c => c.startsWith(start));
