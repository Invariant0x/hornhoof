/* Shared body of the fake agent programs. Real output samples come from ../fixtures. */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOGGED_ENV = ['HH_API_KEY', 
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'CODEX_HOME', 'KIMI_CODE_HOME', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'API_TIMEOUT_MS', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'CODEX_API_KEY', 'NODE_KEY', 'HORNHOOF_DATA', 'HH_TOOL_TOKEN', 'HOME', 'PATH', 'GIT_ASKPASS', 'HH_GIT_PASSWORD', 'GIT_TERMINAL_PROMPT',
  'KIMI_MODEL_THINKING_EFFORT', 'AGY_CLI_DISABLE_AUTO_UPDATE', 'CLAUDE_CODE_OAUTH_TOKEN',
  'DISABLE_AUTOUPDATER', 'KIMI_CODE_NO_AUTO_UPDATE', 'KIMI_CLI_NO_AUTO_UPDATE',
];

const LOGIN_URL = 'https://login.example.test/device?code=ABC';

/* What a message to agy's print mode asks of the fake, for the live terminal tests, where one program sends many. */
const AGY_ASKS = { HANG: 'hang', FAIL: 'fail', TOOLS: 'tools', TICK: 'tick', WORK: 'work', CUT: 'cut', APIFAIL: 'apifail' };

export function run(name) {
  const argv = process.argv.slice(2);
  /* It tells its version and ends, as the real programs do: the node asks after every install whether it starts. */
  if (argv.length === 1 && argv[0] === '--version') {
    process.stdout.write(`2.0.0 (fake ${name})\n`);
    process.exit(0);
  }
  const message = name === 'agy' ? (argv.find(a => a.startsWith('--print=')) ?? '').slice('--print='.length) : '';
  const mode = process.env.FAKE_MODE ?? AGY_ASKS[message.split(' ')[0]] ?? '';
  const log = entry => process.env.FAKE_LOG && appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\n');
  const env = Object.fromEntries(LOGGED_ENV.filter(k => k in process.env).map(k => [k, process.env[k]]));
  /* What the node prepared for this run, read now, since the node may delete it when the run ends. */
  const seen = {};
  const mcpAt = argv.indexOf('--mcp-config');
  if (mcpAt >= 0 && existsSync(argv[mcpAt + 1])) {
    const path = argv[mcpAt + 1];
    seen.mcpConfig = { path, mode: statSync(path).mode, json: JSON.parse(readFileSync(path, 'utf8')) };
  }
  if (existsSync('AGENTS.md')) seen.agentsMd = readFileSync('AGENTS.md', 'utf8');
  const kimiMcp = process.env.KIMI_CODE_HOME && join(process.env.KIMI_CODE_HOME, 'mcp.json');
  if (kimiMcp && existsSync(kimiMcp)) seen.kimiMcp = JSON.parse(readFileSync(kimiMcp, 'utf8'));
  const agyMcp = join('.agents', 'mcp_config.json');
  if (name === 'agy' && existsSync(agyMcp)) seen.agyMcp = { mode: statSync(agyMcp).mode, json: JSON.parse(readFileSync(agyMcp, 'utf8')) };
  log({ name, argv, cwd: process.cwd(), pid: process.pid, env, ...seen });
  const print = file => process.stdout.write(readFileSync(new URL(`../fixtures/${file}.jsonl`, import.meta.url)));
  const words = argv.join(' ');

  if (mode === 'hang') {
    /* A program that ignores SIGTERM and has a child of its own still holding the output pipe. It ignores SIGTERM before
       it tells its child, so a stop sent once the child is known always finds it ignoring. */
    process.on('SIGTERM', () => {});
    const child = spawn('sleep', ['30'], { stdio: 'inherit' });
    log({ grandchild: child.pid });
    return void setInterval(() => {}, 1000);
  }
  /* needs_login: signed out until a login has run in this home. */
  const home = (name === 'agy' ? process.env.HOME : '') || process.env.CLAUDE_CONFIG_DIR || process.env.CODEX_HOME || process.env.KIMI_CODE_HOME || '.';
  const signedIn = mode === 'needs_login' ? existsSync(join(home, 'fake-signed-in')) : mode !== 'signed_out';
  /* claude auth status --json: the account of an interactive sign-in; a long token tells no address or plan. */
  if (name === 'claude' && words === 'auth status --json') {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const status = token ? { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' } : { loggedIn: signedIn, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'x@y.z', orgName: 'Acme', subscriptionType: 'max' };
    process.stdout.write(JSON.stringify(status, null, 2) + '\n');
    process.exit(status.loggedIn ? 0 : 1);
  }
  /* Claude Code with a long token in its env is signed in when the token has the shape setup-token prints. */
  /* FAKE_STATUS_SLEEP: milliseconds it takes to check the token. */
  if (name === 'claude' && words === 'auth status' && process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    const ok = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(process.env.CLAUDE_CODE_OAUTH_TOKEN);
    return void setTimeout(() => process.exit(ok ? 0 : 1), Number(process.env.FAKE_STATUS_SLEEP) || 0);
  }
  if (words === 'auth status' || words === 'login status') process.exit(signedIn ? 0 : 1);
  /* claude setup-token: a link, a code the person types, then the long token, wrapped at FAKE_WRAP columns as Ink wraps
     it on a narrow screen. A wrong code or login_fail ends it with an error. */
  if (name === 'claude' && words === 'setup-token') {
    process.stdout.write(`Browser didn't open? Use the url below to sign in\n\n${LOGIN_URL}\n\nPaste code here if prompted > `);
    let typed = '';
    process.stdin.setEncoding('utf8');
    return void process.stdin.on('data', chunk => {
      typed += chunk;
      if (!/[\r\n]/.test(typed)) return;
      if (mode === 'login_fail' || typed.trim() !== 'code123') {
        process.stdout.write('\nOAuth error: Invalid code\n');
        process.exit(1);
      }
      const token = process.env.FAKE_TOKEN ?? '';
      /* FAKE_WRAP=tty: as wide as the terminal it runs in. */
      const width = (process.env.FAKE_WRAP === 'tty' ? process.stdout.columns : Number(process.env.FAKE_WRAP)) || token.length || 1;
      const wrapped = token.match(new RegExp(`.{1,${width}}`, 'g'))?.join('\n') ?? '';
      process.stdout.write(`\n\u2713 Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n\x1b[33m${wrapped}\x1b[39m\n\nStore this token securely. You won't be able to see it again.\n\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\n`);
      process.exit(0);
    });
  }
  /* agy 1.4.12 lists its models only when signed in, and says so otherwise. */
  if (name === 'agy' && words === 'models') {
    if (!signedIn) {
      process.stdout.write('Fetching available models...\n');
      process.stderr.write('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.\n');
      process.exit(1);
    }
    return void process.stdout.write(readFileSync(new URL('../fixtures/agy-models.txt', import.meta.url)));
  }
  /* agy 1.4.12 prints the plan's quota buckets for `/usage` in JSON when signed in. */
  if (name === 'agy' && words === '--print=/usage --output-format json') {
    const limitsMode = process.env.FAKE_LIMITS_MODE ?? mode;
    if (!signedIn || limitsMode === 'fail') {
      process.stderr.write(signedIn ? 'error: failed to fetch usage\n' : 'Error: Please sign in to view usage.\n');
      process.exit(1);
    }
    if (limitsMode === 'bad_json') {
      process.stdout.write('{broken\n');
      process.exit(0);
    }
    if (limitsMode === 'stderr_noise') process.stderr.write('Checking for updates...\n');
    const custom = join(home, 'fake-agy-usage.json');
    return void process.stdout.write(existsSync(custom) ? readFileSync(custom) : readFileSync(new URL('../fixtures/agy-usage.json', import.meta.url)));
  }
  if (name === 'codex' && words === 'app-server') return void appServer(signedIn);
  if (words === 'auth login' || words === 'login --device-auth' || words === 'login') {
    if (mode === 'login_fail') {
      process.stderr.write('Error logging in: the device code expired\n');
      process.exit(1);
    }
    writeFileSync(join(home, 'fake-signed-in'), '');
    if (name === 'codex' && process.env.CODEX_HOME) writeFileSync(join(process.env.CODEX_HOME, 'auth.json'), JSON.stringify({ tokens: { access_token: process.env.FAKE_TOKEN ?? 'fake-access' } }));
    /* Colored, inside a terminal hyperlink, the way the real programs print it. */
    process.stdout.write(`Open this link:\n\x1b[94m\x1b]8;;${LOGIN_URL}\x07${LOGIN_URL}\x1b]8;;\x07\x1b[0m\n`);
    process.exit(0);
  }
  if (mode === 'killed') {
    process.stderr.write('boom\n');
    process.kill(process.pid, 'SIGKILL');
    return;
  }
  if (mode === 'fail-long') {
    for (let i = 0; i < 60; i++) process.stdout.write(`output ${i}\n`);
    process.stderr.write(`boom ${process.env.FAKE_ERROR_SECRET}\n\n\n`);
    process.exit(3);
  }
  if (mode === 'signed_out') signedOutRun(name, print);
  if (mode === 'fail') failedRun(name, print);
  /* An agent that prints the sign-in it was started with, which nobody may see. */
  if (mode === 'say_token' && name === 'claude') {
    const text = `my token is ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`;
    process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', is_error: false, result: text, session_id: '5e55c1a0-0000-4000-8000-000000000001' }) + '\n');
    process.exit(0);
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
  if (name === 'agy' && Object.hasOwn(AGY_RUNS, mode)) return void AGY_RUNS[mode](print);
  if (mode === 'tools') return void print(`${name}-tools`);
  if (mode === 'odd-lines') {
    /* Valid JSON that is no event: the node goes on to the real output after it. */
    process.stdout.write('null\n[]\n"text"\n42\n');
    return void print(`${name}-new`);
  }
  if (mode === 'background' && name === 'claude') {
    /* A background shell task that ends after the answer adds an empty zero-turn result. */
    print('claude-new');
    return void process.stdout.write('{"type":"result","subtype":"success","is_error":false,"result":"","num_turns":0,"session_id":"5e55c1a0-0000-4000-8000-000000000001"}\n');
  }
  const resume = name === 'claude' ? argv.includes('--resume') : name === 'codex' ? argv[1] === 'resume' : name === 'agy' ? argv.includes('--conversation') : argv.includes('--session');
  print(`${name}-${resume ? 'resume' : 'new'}`);
}

/* What each program prints when it is not signed in, and how it fails. */
function signedOutRun(name, print) {
  if (name === 'kimi') {
    process.stdout.write('{"role":"meta","type":"system.version","version":"2.4.0"}\n');
    process.stderr.write('error: failed to run prompt: No model configured. Run `kimi` and use /login to sign in, then retry.\n');
  } else print(`${name}-signed-out`);
  if (name === 'agy') process.stderr.write('Waiting for authentication (timeout 60s)...\nOr, paste the authorization code here and press Enter:\nError: authentication timed out.\nerror: authentication failed or timed out\n');
  process.exit(1);
}

const FAILURES = {
  claude: () => process.stdout.write('{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Something broke","session_id":"5e55c1a0-0000-4000-8000-000000000001"}\n'),
  codex: () => process.stdout.write('{"type":"thread.started","thread_id":"c0dec000-0000-7000-8000-000000000009"}\n{"type":"turn.failed","error":{"message":"stream error: something broke"}}\n'),
  kimi: () => process.stderr.write('error: failed to run prompt: something broke\n'),
  agy: print => print('agy-fail'),
};

function failedRun(name, print) {
  FAILURES[name]?.(print);
  process.exit(1);
}

/* agy's print runs that the live terminal tests ask for by their message's first word. */
const AGY_RUNS = {
  apifail: () => {
    agyToolStep('ACTIVE');
    agyToolStep('ERROR');
    process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'The server is overloaded', finished_reason: 'error' } }) + '\n');
    process.stderr.write('AGY_ERROR: {"short_error":"The server is overloaded","retryable":false}\n');
    process.exitCode = 3;
  },
  /* A tool step from agy's docs, then a whole turn, so the run ends with a result. */
  tools: print => {
    print('agy-tools');
    print('agy-new');
  },
  /* Works for 4 s, telling only on the screen how long, as on stderr, which agy's print mode keeps out of its stream. */
  tick: print => {
    let worked = 0;
    const tick = setInterval(() => process.stderr.write(`Working ${(worked += 250)} ms\n`), 250);
    setTimeout(() => {
      clearInterval(tick);
      print('agy-new');
    }, 4000);
  },
  /* Thinks for 1.5 s, then runs a command for 1.5 s, as agy updates a tool step while it runs and once it is done. */
  work: print => {
    setTimeout(() => {
      agyToolStep('ACTIVE');
      setTimeout(() => {
        agyToolStep('DONE');
        print('agy-new');
      }, 1500);
    }, 1500);
  },
  /* Starts a command and then prints nothing more, never ending, as agy did when its stream broke off mid-turn with a 503
     from its backend while its work went on. */
  cut: () => {
    agyToolStep('ACTIVE');
    setInterval(() => {}, 1000);
  },
};

const agyToolStep = state => process.stdout.write(JSON.stringify({ event: 'step_update', step_update: { step_index: 2, state, step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'make' }, ...(state === 'DONE' ? { output: 'built\n' } : {}) } } }) + '\n');

/* Codex's app server over stdin and stdout, one JSON-RPC message a line: the plan's limits as Codex 0.166 answers them. */
function appServer(signedIn) {
  const answer = m => process.stdout.write(JSON.stringify(m) + '\n');
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === 'initialize') answer({ id: m.id, result: { userAgent: 'codex_cli_rs/0.166.0' } });
      if (m.method !== 'account/rateLimits/read') continue;
      if (!signedIn) answer({ id: m.id, error: { code: -32600, message: 'codex account authentication required to read rate limits' } });
      else
        answer({
          id: m.id,
          result: {
            ordinaryUsageAllowed: true,
            rateLimits: {
              limitId: 'codex',
              primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Date.parse('2026-10-31T03:00:00Z') / 1000 },
              secondary: { usedPercent: 73, windowDurationMins: 10080, resetsAt: Date.parse('2026-11-04T10:00:00Z') / 1000 },
              planType: 'pro',
              rateLimitReachedType: null,
            },
          },
        });
    }
  });
}
