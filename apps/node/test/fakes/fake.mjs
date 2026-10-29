/* Shared body of the fake agent programs. Real output samples come from ../fixtures. */
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const LOGGED_ENV = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'KIMI_CODE_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'API_TIMEOUT_MS', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CODEX_API_KEY', 'NODE_KEY', 'HORNHOOF_DATA', 'PATH',
];

const LOGIN_URL = 'https://login.example.test/device?code=ABC';

export function run(name) {
  const argv = process.argv.slice(2);
  const mode = process.env.FAKE_MODE ?? '';
  const log = entry => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n');
  const env = Object.fromEntries(LOGGED_ENV.filter(k => k in process.env).map(k => [k, process.env[k]]));
  log({ name, argv, cwd: process.cwd(), pid: process.pid, env });
  const print = file => process.stdout.write(readFileSync(new URL(`../fixtures/${file}.jsonl`, import.meta.url)));
  const words = argv.join(' ');

  if (mode === 'hang') {
    /* A program that ignores SIGTERM and has a child of its own still holding the output pipe. */
    const child = spawn('sleep', ['30'], { stdio: 'inherit' });
    log({ grandchild: child.pid });
    process.on('SIGTERM', () => {});
    return void setInterval(() => {}, 1000);
  }
  if (words === 'auth status' || words === 'login status') process.exit(mode === 'signed_out' ? 1 : 0);
  if (words === 'auth login' || words === 'login --device-auth' || words === 'login') {
    /* Colored, inside a terminal hyperlink, the way the real programs print it. */
    process.stdout.write(`Open this link:\n\x1b[94m\x1b]8;;${LOGIN_URL}\x07${LOGIN_URL}\x1b]8;;\x07\x1b[0m\n`);
    process.exit(0);
  }
  if (mode === 'signed_out') {
    if (name === 'kimi') {
      process.stdout.write('{"role":"meta","type":"system.version","version":"2.4.0"}\n');
      process.stderr.write('error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry.\n');
    } else print(`${name}-signed-out`);
    process.exit(1);
  }
  if (mode === 'fail') {
    if (name === 'claude') process.stdout.write('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Something broke","session_id":"5e55c1a0-0000-4000-8000-000000000001"}\n');
    if (name === 'codex') process.stdout.write('{"type":"thread.started","thread_id":"c0dec000-0000-7000-8000-000000000009"}\n{"type":"turn.failed","error":{"message":"stream error: something broke"}}\n');
    if (name === 'kimi') process.stderr.write('error: failed to run prompt: something broke\n');
    process.exit(1);
  }
  if (mode === 'auth_error' && name === 'claude') {
    /* The error code alone, with a message the sign-in patterns do not know. */
    process.stdout.write('{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Token expired"}]}}\n{"type":"result","is_error":true,"result":"Token expired","session_id":"5e55c1a0-0000-4000-8000-000000000003"}\n');
    process.exit(1);
  }
  if (mode === 'bad_key' && name === 'codex') {
    print('codex-api-key-invalid');
    process.exit(1);
  }
  const resume = name === 'claude' ? argv.includes('--resume') : name === 'codex' ? argv[1] === 'resume' : argv.includes('--session');
  print(`${name}-${resume ? 'resume' : 'new'}`);
}
