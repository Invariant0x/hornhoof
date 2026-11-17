import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { testApp } from './helpers.js';

const SERVER = 'https://hornhoof.example.test';
const COMMIT = 'c'.repeat(40);
const DIGEST = `sha256:${'e'.repeat(64)}`;
const UPDATER = `ghcr.io/invariant0x/hornhoof-updater@${DIGEST}`;
/* A code may start with a dash, as base64url may. */
const CODE = '-Ab3_d-Ef'.repeat(4) + 'xyz';

/* The Windows installer GET /install.ps1 answers on a server of this commit, whose registry knows this digest of the updater. */
async function served(env: Record<string, string> = { PUBLIC_URL: SERVER }, commit = COMMIT) {
  const { app } = await testApp({ HORNHOOF_VERSION: '0.7.3', HORNHOOF_COMMIT: commit, ...env });
  vi.spyOn(app.ctx.updates, 'siblings').mockResolvedValue({ node: '', updater: DIGEST });
  return app.inject({ url: '/install.ps1' });
}

describe('GET /install.ps1', () => {
  it("serves the Windows installer with this server's address and the updater image of its build filled in", async () => {
    const res = await served();
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toContain(`$server = '${SERVER}'`);
    expect(res.body).toContain(`$helper = '${UPDATER}'`);
    expect(res.body).not.toMatch(/__HORNHOOF_[A-Z_]+__/);
  });

  it('is plain ASCII, which Windows PowerShell reads the same in any language Windows runs in', async () => {
    expect((await served()).body).toMatch(/^[\x09\x0a\x0d\x20-\x7e]*$/);
  });
});

/* Where pwsh is, if this computer has it: the script runs there with a stub in place of docker. */
const PWSH = spawnSync('sh', ['-c', 'command -v pwsh'], { encoding: 'utf8' }).stdout.trim();

/* docker as install.ps1 meets it, writing each call and the settings it was handed as a line of JSON. STUB_DOCKER "stopped"
   answers info only once Docker Desktop started; STUB_OSTYPE is the kind of containers it runs; STUB_PULL "fail" downloads
   nothing and STUB_IMAGE_LOCAL "1" has the image here. run runs the shell command it gets, as the container would, with curl
   writing STUB_INSTALL_SH where it is told to, and ends as that ends. exec reads the sign-in link install.sh wrote in the
   container, STUB_OPEN_URL, and counts each look; with STUB_RUN_UNTIL_LOOKS run lasts until that many looks were taken. */
const DOCKER_STUB = `#!${process.execPath}
const { appendFileSync, existsSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const env = {};
for (const name of ['HORNHOOF_SERVER', 'HORNHOOF_HOME', 'HORNHOOF_MACHINE', 'HORNHOOF_HOST_CPU', 'HORNHOOF_HOST_CPUS', 'HORNHOOF_HOST_MEMORY', 'HORNHOOF_FROM_WINDOWS']) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, env }) + '\\n');
const s = process.env;
if (args[0] === 'info') {
  if ((s.STUB_DOCKER || 'ok') !== 'ok' && !existsSync(s.STUB_STATE + '/started')) { console.error('error during connect'); process.exit(1); }
  if (args.join(' ').includes('OSType')) console.log(s.STUB_OSTYPE || 'linux');
} else if (args[0] === 'pull') {
  if (s.STUB_PULL === 'fail') process.exit(1);
} else if (args[0] === 'image') {
  if (s.STUB_IMAGE_LOCAL !== '1') process.exit(1);
} else if (args[0] === 'exec') {
  if (args.at(-1) !== '/tmp/hornhoof-open-url') process.exit(1);
  appendFileSync(s.STUB_STATE + '/looks', 'look\\n');
  if (!s.STUB_OPEN_URL) process.exit(1);
  console.log(s.STUB_OPEN_URL);
} else if (args[0] === 'run') {
  const looks = () => existsSync(s.STUB_STATE + '/looks') ? readFileSync(s.STUB_STATE + '/looks', 'utf8').split('\\n').filter(Boolean).length : 0;
  while (looks() < Number(s.STUB_RUN_UNTIL_LOOKS || 0)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  const c = args.indexOf('-c');
  const r = spawnSync('/bin/sh', args.slice(c), { stdio: 'inherit', env: { ...process.env, HORNHOOF_HOME: s.STUB_STATE + '/inside' } });
  process.exit(r.status);
}
`;

/* curl in the container: it writes the installer the test gave to the file it is told to. */
const CURL_STUB = `#!/bin/sh
[ -n "$STUB_INSTALL_SH" ] || { echo 'curl: (6) Could not resolve host' >&2; exit 6; }
echo "curl $*" >> "$STUB_STATE/curl.log"
while [ $# -gt 1 ]; do [ "$1" = -o ] && cp "$STUB_INSTALL_SH" "$2"; shift; done
`;

/* What install.sh does with what it gets: the words, the key where it looks for it, and an end. */
const INSTALL_SH = `printf 'install.sh %s\\n' "$*"
printf 'machine %s\\n' "$(cat "$HORNHOOF_HOME/machine")"
exit "\${STUB_INSTALL_EXIT:-0}"
`;

/* Docker Desktop as its installer puts it in Program Files: docker.exe, which Windows finds as docker and a Mac only by that
   name too, and the app, which starts Docker. */
const PUT_DOCKER = `#!/bin/sh
d="$ProgramFiles/Docker/Docker"
mkdir -p "$d/resources/bin"
cp "$STUB_STATE/docker-stub" "$d/resources/bin/docker.exe"
cp "$STUB_STATE/docker-stub" "$d/resources/bin/docker"
printf '#!/bin/sh\\ntouch "%s/started"\\n' "$STUB_STATE" > "$d/Docker Desktop.exe"
chmod +x "$d/Docker Desktop.exe"
`;

/* The Windows programs install.ps1 runs, each writing its call as a line of windows.log. winget and the downloaded installer
   install Docker Desktop, or fail with STUB_INSTALL_FAIL "1". reg knows a restart Windows waits for with STUB_RESTART "1",
   and keeps the RunOnce value in the file runonce. */
const WINDOWS_STUBS: Record<string, string> = {
  winget: `#!/bin/sh
echo "winget $*" >> "$STUB_STATE/windows.log"
[ "$STUB_INSTALL_FAIL" = 1 ] && exit 1
exec "$STUB_STATE/put-docker"
`,
  installer: `#!/bin/sh
echo "installer $*" >> "$STUB_STATE/windows.log"
[ "$STUB_INSTALL_FAIL" = 1 ] && exit 1
exec "$STUB_STATE/put-docker"
`,
  /* The browser of the system, which PowerShell's Start-Process opens a link with on Linux. */
  'xdg-open': `#!/bin/sh
echo "open $*" >> "$STUB_STATE/windows.log"
`,
  reg: `#!/bin/sh
echo "reg $*" >> "$STUB_STATE/windows.log"
case "$1" in
  query) case "$2" in *'Component Based Servicing\\RebootPending') [ "$STUB_RESTART" = 1 ] && exit 0;; esac; exit 1;;
  add) while [ $# -gt 1 ]; do [ "$1" = /d ] && printf %s "$2" > "$STUB_STATE/runonce"; shift; done;;
  delete) rm -f "$STUB_STATE/runonce";;
esac
`,
};

/* What PowerShell itself does on Windows only, in front of the script. The one PowerShell Windows asks about runs here as
   pwsh, and STUB_UAC "no" is the person saying no to it. The download is the installer above, signed by STUB_SIGNER, or
   with STUB_DOWNLOAD "cut" a part of it and a lost connection. irm
   reads the script from a file, once failing as without a network when the file offline is there. */
/* wsl answers --version as STUB_WSL says: "none" has no WSL of its own yet, "old" one before 2.1.5. It ends its other calls
   with STUB_WSL_EXIT. It is a PowerShell script, as no program here ends with 3010, which Windows installers say. */
const WSL_STUB = `Add-Content -LiteralPath "$env:STUB_STATE/windows.log" -Value "wsl $($args -join ' ')"
if ($args[0] -eq '--version') {
  if ($env:STUB_WSL -eq 'none') { 'The Windows Subsystem for Linux is not installed.'; exit 1 }
  if ($env:STUB_WSL -eq 'old') { 'WSL version: 2.0.9.0', 'Kernel version: 5.15.133.1-1' } else { 'WSL version: 2.3.26.0', 'Kernel version: 5.15.167.4-1' }
  exit 0
}
exit [int]$env:STUB_WSL_EXIT
`;

const WINDOWS_CMDLETS = `
function Start-Process { param($FilePath, $ArgumentList, $Verb, [switch]$Wait, [switch]$PassThru)
  if (-not $Verb) { return Microsoft.PowerShell.Management\\Start-Process @PSBoundParameters }
  Add-Content -LiteralPath "$env:STUB_STATE/windows.log" -Value "elevate $FilePath $Verb $Wait $PassThru"
  if ($env:STUB_UAC -eq 'no') { throw 'This command cannot be run due to the error: The operation was canceled by the user.' }
  & $env:STUB_PWSH @ArgumentList | Out-Host
  [pscustomobject]@{ ExitCode = $LASTEXITCODE }
}
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing)
  Add-Content -LiteralPath "$env:STUB_STATE/windows.log" -Value "download $Uri"
  if ($env:STUB_DOWNLOAD -eq 'cut') { Set-Content -LiteralPath $OutFile -Value 'MZ'; throw 'The connection was closed unexpectedly.' }
  /bin/cp "$env:STUB_STATE/installer" $OutFile
}
function Get-AuthenticodeSignature { param($FilePath)
  $signer = if ($env:STUB_SIGNER) { $env:STUB_SIGNER } else { 'CN=Docker Inc, O=Docker Inc, L=San Francisco, S=California, C=US' }
  [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = $signer } }
}
function Invoke-RestMethod { param($Uri)
  Add-Content -LiteralPath "$env:STUB_STATE/windows.log" -Value "irm $Uri"
  if (Test-Path "$env:STUB_STATE/offline") { Remove-Item "$env:STUB_STATE/offline"; throw 'No such host is known.' }
  [IO.File]::ReadAllText("$env:STUB_STATE/install.ps1")
}
`;

type Run = { args?: string[]; env?: Record<string, string>; docker?: boolean; app?: boolean; winget?: boolean; home?: string; dir?: string; command?: string };

function windows(script: string, { args = ['--join', CODE], env = {}, docker = true, app = false, winget = false, home, dir = mkdtempSync(join(tmpdir(), 'hh-ps1-')), command }: Run = {}) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(dir, 'install.ps1');
  writeFileSync(file, script);
  writeFileSync(join(dir, 'docker-stub'), DOCKER_STUB, { mode: 0o755 });
  if (docker) writeFileSync(join(bin, 'docker'), DOCKER_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), CURL_STUB, { mode: 0o755 });
  writeFileSync(join(bin, 'wsl.ps1'), WSL_STUB);
  writeFileSync(join(bin, 'reg'), WINDOWS_STUBS.reg!, { mode: 0o755 });
  writeFileSync(join(bin, 'xdg-open'), WINDOWS_STUBS['xdg-open']!, { mode: 0o755 });
  if (winget) writeFileSync(join(bin, 'winget'), WINDOWS_STUBS.winget!, { mode: 0o755 });
  writeFileSync(join(dir, 'installer'), WINDOWS_STUBS.installer!, { mode: 0o755 });
  writeFileSync(join(dir, 'put-docker'), PUT_DOCKER, { mode: 0o755 });
  writeFileSync(join(dir, 'install.sh'), INSTALL_SH);
  const programs = join(dir, 'programs');
  if (app) {
    const desktop = join(programs, 'Docker', 'Docker');
    mkdirSync(desktop, { recursive: true });
    writeFileSync(join(desktop, 'Docker Desktop.exe'), `#!/bin/sh\ntouch "${dir}/started"\n`);
    chmodSync(join(desktop, 'Docker Desktop.exe'), 0o755);
  }
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(join(dir, 'windows.log'), '');
  /* As the command Hornhoof shows runs it, with the script read from the file in place of irm. */
  command ??= `& ([scriptblock]::Create([IO.File]::ReadAllText('${file}'))) ${args.join(' ')}`;
  const res = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-c', WINDOWS_CMDLETS + command], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home ?? join(dir, 'home'),
      TMPDIR: dir,
      ProgramFiles: programs,
      STUB_LOG: log,
      STUB_STATE: dir,
      STUB_INSTALL_SH: join(dir, 'install.sh'),
      STUB_PWSH: PWSH,
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as { args: string[]; env: Record<string, string> });
  const done = readFileSync(join(dir, 'windows.log'), 'utf8').trim().split('\n').filter(Boolean);
  /* The watcher reads the sign-in link from the container beside the run, as often as time allows. */
  const own = calls.filter(c => c.args[0] !== 'exec');
  return { code: res.status, out: res.stdout + res.stderr, calls: own, looks: calls.filter(c => c.args[0] === 'exec'), done, dir, run: calls.find(c => c.args[0] === 'run') };
}

const NOTICE = 'Installing Docker Desktop, where Hornhoof runs its nodes. Docker Desktop has its own terms: free for personal use and small companies, see https://docs.docker.com/subscription/desktop-license/';
const DOCKER_OPTIONS = 'install --quiet --accept-license --backend=wsl-2';
const WINGET = `winget install -e --id Docker.DockerDesktop --source winget --accept-package-agreements --accept-source-agreements --silent --override ${DOCKER_OPTIONS}`;
const ELEVATE = 'elevate powershell.exe RunAs True True';
const RUN_ONCE = 'powershell -NoExit -ExecutionPolicy Bypass -c ';
const elevated = (done: string[]) => done.filter(line => line.startsWith('elevate '));
/* What installed something, in order. */
const installs = (done: string[]) => done.filter(line => /^(winget|installer|download|wsl --(install|update))/.test(line));

/* The installer this server serves, fetched once for the scenarios that need no other. */
let servedScript: Promise<string> | undefined;
const script = () => (servedScript ??= served().then(res => res.body));

describe.runIf(PWSH)('install.ps1 in PowerShell', () => {
  it("runs the server's install.sh in the updater image of its build with this computer's Docker, the words of the command and the computer's key", async () => {
    const script = (await served()).body;
    const home = mkdtempSync(join(tmpdir(), 'hh-ps1-home-'));
    const r = windows(script, { home });
    expect(r.code).toBe(0);
    expect(r.calls.map(c => c.args[0])).toEqual(['info', 'info', 'pull', 'run']);
    expect(r.calls[2]!.args).toEqual(['pull', UPDATER]);
    const run = r.run!.args;
    expect(run.slice(0, 3)).toEqual(['run', '--rm', '-i']);
    /* A name of its own, by which the watcher reads the sign-in link in it. */
    expect(run[run.indexOf('--name') + 1]).toMatch(/^hornhoof-install-[0-9a-f]{12}$/);
    expect(run[run.indexOf('--hostname') + 1]).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/);
    expect(run[run.indexOf('-v') + 1]).toBe('//var/run/docker.sock:/var/run/docker.sock');
    expect(run.slice(run.indexOf('--entrypoint'), run.indexOf('-c'))).toEqual(['--entrypoint', 'sh', UPDATER]);
    expect(run.slice(run.indexOf('-c') + 2)).toEqual(['install', '--join', CODE]);
    /* Settings go through the environment by name only, so no value is on a command line. */
    expect(run.filter((_, i) => run[i - 1] === '-e').every(word => /^HORNHOOF_[A-Z_]+$/.test(word))).toBe(true);
    const key = readFileSync(join(home, '.hornhoof', 'machine'), 'utf8');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(r.run!.env).toMatchObject({ HORNHOOF_SERVER: SERVER, HORNHOOF_HOME: '/hornhoof', HORNHOOF_MACHINE: key, HORNHOOF_FROM_WINDOWS: '1' });
    expect(r.run!.env.HORNHOOF_HOST_CPUS).toMatch(/^[1-9][0-9]*$/);
    expect(r.out).toContain(`install.sh --join ${CODE}`);
    expect(r.out).toContain(`machine ${key}`);
    expect(readFileSync(join(r.dir, 'curl.log'), 'utf8')).toContain(`${SERVER}/install.sh`);

    /* The update without a code goes as this computer, with the same key. */
    const again = windows(script, { args: [], home });
    expect(again.code).toBe(0);
    expect(again.run!.args.at(-1)).toBe('install');
    expect(again.run!.env.HORNHOOF_MACHINE).toBe(key);
    expect(again.out).toContain(`machine ${key}`);
  });

  it('shows the first of the four steps, the one for Docker Desktop, before it checks Docker Desktop, and none for a removal', async () => {
    const r = windows(await script());
    expect(r.code).toBe(0);
    const step = r.out.indexOf('Step 1 of 4: Checking this computer');
    expect(step).toBeGreaterThanOrEqual(0);
    expect(r.out.indexOf('Checking Docker Desktop.')).toBeGreaterThan(step);
    /* Its input is no console, so it waits for no Enter. */
    expect(r.out).not.toContain('Press Enter');
    const removal = windows(await script(), { args: ['--uninstall'] });
    expect(removal.code).toBe(0);
    expect(removal.out).not.toContain('Step 1 of 4');
  });

  /* PowerShell on a Mac opens a link with /usr/bin/open, the real browser, so this runs on Linux only. */
  it.skipIf(process.platform === 'darwin')('opens the sign-in link install.sh hands over in the browser of Windows, each link once and only a plain https one', async () => {
    const link = 'https://claude.ai/oauth/authorize?code=1';
    const r = windows(await script(), { env: { STUB_OPEN_URL: link, STUB_RUN_UNTIL_LOOKS: '3' } });
    expect(r.code).toBe(0);
    expect(r.done.filter(l => l.startsWith('open '))).toEqual([`open ${link}`]);
    const name = r.run!.args[r.run!.args.indexOf('--name') + 1];
    expect(r.looks.length).toBeGreaterThanOrEqual(3);
    for (const look of r.looks) expect(look.args).toEqual(['exec', name, 'cat', '/tmp/hornhoof-open-url']);
    for (const odd of ['file:///etc/passwd', 'https://claude.ai/x y']) {
      const other = windows(await script(), { env: { STUB_OPEN_URL: odd, STUB_RUN_UNTIL_LOOKS: '2' } });
      expect(other.code).toBe(0);
      expect(other.done.filter(l => l.startsWith('open '))).toEqual([]);
    }
  });

  it('takes the latest updater image for a server CI did not build', async () => {
    const r = windows((await served({ PUBLIC_URL: SERVER }, 'local')).body);
    expect(r.code).toBe(0);
    expect(r.run!.args).toContain('ghcr.io/invariant0x/hornhoof-updater:latest');
  });

  it('installs missing Docker Desktop with winget after one line on what and under which terms, asks Windows once, then goes on', async () => {
    const r = windows(await script(), { docker: false, winget: true, env: { STUB_DOCKER: 'stopped' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(NOTICE);
    expect(r.out).toContain('Windows asks once to allow the changes: choose Yes.');
    expect(elevated(r.done)).toEqual([ELEVATE]);
    expect(installs(r.done)).toEqual([WINGET]);
    expect(r.out).toContain('Starting Docker Desktop.');
    expect(r.run!.args.slice(-3)).toEqual(['install', '--join', CODE]);
  });

  it.each([
    ['an Intel or AMD', '', 'amd64'],
    ['an Arm', 'ARM64', 'arm64'],
  ])("downloads Docker Desktop's own installer for %s processor when there is no winget, runs it as Docker documents and removes it", async (_, processor, kind) => {
    const r = windows(await script(), { docker: false, env: { STUB_DOCKER: 'stopped', PROCESSOR_ARCHITECTURE: processor } });
    expect(r.code).toBe(0);
    expect(r.out).toContain(NOTICE);
    expect(installs(r.done)).toEqual([`download https://desktop.docker.com/win/main/${kind}/Docker%20Desktop%20Installer.exe`, `installer ${DOCKER_OPTIONS}`]);
    expect(elevated(r.done)).toEqual([ELEVATE]);
    expect(existsSync(join(r.dir, 'Docker Desktop Installer.exe'))).toBe(false);
    expect(r.run).toBeDefined();
  });

  it('says so when the download breaks off, and leaves no part of it behind', async () => {
    const r = windows(await script(), { docker: false, env: { STUB_DOWNLOAD: 'cut' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Could not download Docker Desktop from https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe. Check the internet connection, then run this command again.');
    expect(elevated(r.done)).toEqual([]);
    expect(existsSync(join(r.dir, 'Docker Desktop Installer.exe'))).toBe(false);
  });

  it('runs no downloaded installer Docker did not sign, and removes it', async () => {
    const r = windows(await script(), { docker: false, env: { STUB_SIGNER: 'CN=Someone Else, O=Someone Else' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('is not signed by Docker');
    expect(elevated(r.done)).toEqual([]);
    expect(existsSync(join(r.dir, 'Docker Desktop Installer.exe'))).toBe(false);
  });

  it.each([
    ['no WSL of its own', 'none', 'wsl --install --no-distribution'],
    ['a WSL older than Docker Desktop needs', 'old', 'wsl --update'],
  ])('turns on WSL 2 first, under the same one Windows prompt, when Windows has %s', async (_, wsl, step) => {
    const r = windows(await script(), { docker: false, winget: true, env: { STUB_DOCKER: 'stopped', STUB_WSL: wsl } });
    expect(r.code).toBe(0);
    expect(installs(r.done)).toEqual([step, WINGET]);
    expect(elevated(r.done)).toEqual([ELEVATE]);
  });

  it('gets Docker Desktop that is there but cannot run without WSL 2 only that', async () => {
    const r = windows(await script(), { app: true, env: { STUB_DOCKER: 'stopped', STUB_WSL: 'none' } });
    expect(r.code).toBe(0);
    expect(installs(r.done)).toEqual(['wsl --install --no-distribution']);
    expect(r.out).not.toContain(NOTICE);
    expect(r.run).toBeDefined();
  });

  it.each([
    ['the person says no to Windows', { STUB_UAC: 'no' }, 'Run this command again and choose Yes', []],
    ['WSL 2 does not turn on', { STUB_WSL: 'none', STUB_WSL_EXIT: '1' }, 'Windows could not turn on WSL 2', ['wsl --install --no-distribution']],
    ['Docker Desktop does not install', { STUB_INSTALL_FAIL: '1' }, 'Docker Desktop did not install.', [WINGET]],
  ])('stops with what to do when %s', async (_, env, says, ran) => {
    const r = windows(await script(), { docker: false, winget: true, env });
    expect(r.code).toBe(1);
    expect(r.out).toContain(says);
    expect(installs(r.done)).toEqual(ran);
    expect(r.run).toBeUndefined();
  });

  it('says plainly when Windows needs a restart, and has Windows run the same command once the person signs in again', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hh-ps1-home-'));
    const r = windows(await script(), { docker: false, winget: true, home, env: { STUB_WSL: 'none', STUB_RESTART: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Restart needed');
    expect(r.out).toContain('Windows needs a restart to finish installing. Restart the computer; when you sign in again, Hornhoof goes on by itself in a PowerShell window.');
    expect(r.out).toContain('To restart, save your open work, then choose Start, Power, Restart. After the restart, leave the Hornhoof window open until it says Done.');
    expect(r.run).toBeUndefined();
    const line = readFileSync(join(r.dir, 'runonce'), 'utf8');
    expect(line).toBe(`${RUN_ONCE}for(;;){try{$s=irm ${SERVER}/install.ps1;break}catch{'Waiting for the network.';sleep 2}};&([scriptblock]::Create($s)) --join ${CODE}`);
    expect(line.length).toBeLessThanOrEqual(260);
    expect(r.done.filter(l => l.startsWith('reg add'))).toEqual([`reg add HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce /v Hornhoof /t REG_SZ /d ${line} /f`]);
    /* The code is kept nowhere else this script writes. */
    const kept = readdirSync(home, { recursive: true, withFileTypes: true }).filter(f => f.isFile());
    expect(kept.filter(f => readFileSync(join(f.parentPath, f.name), 'utf8').includes(CODE))).toEqual([]);
  });

  it('takes the end 3010 of a step, with which Windows installers say a restart finishes their work, for a restart too', async () => {
    const r = windows(await script(), { docker: false, winget: true, env: { STUB_WSL: 'none', STUB_WSL_EXIT: '3010' } });
    expect(r.code).toBe(0);
    expect(installs(r.done)).toEqual(['wsl --install --no-distribution', WINGET]);
    expect(r.out).toContain('Restart the computer');
    expect(existsSync(join(r.dir, 'runonce'))).toBe(true);
  });

  it('asks the person to run the command again after the restart when its words would not fit in RunOnce', async () => {
    const r = windows(await script(), { docker: false, winget: true, args: ['--join', 'x'.repeat(120)], env: { STUB_RESTART: '1' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Restart the computer, then run this command again.');
    expect(existsSync(join(r.dir, 'runonce'))).toBe(false);
  });

  it('goes on after the restart from RunOnce, waiting for the network first', async () => {
    const before = windows(await script(), { docker: false, winget: true, env: { STUB_WSL: 'none', STUB_RESTART: '1' } });
    const line = readFileSync(join(before.dir, 'runonce'), 'utf8');
    /* Windows deletes the value before it runs the command, which goes to powershell as it stands after -c. */
    expect(line.startsWith(RUN_ONCE)).toBe(true);
    rmSync(join(before.dir, 'runonce'));
    writeFileSync(join(before.dir, 'offline'), '');
    const after = windows(await script(), { dir: before.dir, docker: false, command: line.slice(RUN_ONCE.length), env: { STUB_DOCKER: 'stopped' } });
    expect(after.code).toBe(0);
    expect(after.out).toContain('Waiting for the network.');
    expect(after.done.filter(l => l.startsWith('irm '))).toEqual([`irm ${SERVER}/install.ps1`, `irm ${SERVER}/install.ps1`]);
    expect(elevated(after.done)).toEqual([]);
    expect(after.out).toContain('Starting Docker Desktop.');
    expect(after.run!.args.slice(-3)).toEqual(['install', '--join', CODE]);
    expect(after.out).toContain(`install.sh --join ${CODE}`);
  });

  it('removes a command waiting in RunOnce for a restart once the person ran it again by hand, which uses its code up', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-ps1-'));
    writeFileSync(join(dir, 'runonce'), `${RUN_ONCE}--join ${CODE}`);
    const r = windows(await script(), { dir });
    expect(r.code).toBe(0);
    expect(r.done).toContain('reg delete HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce /v Hornhoof /f');
    expect(existsSync(join(dir, 'runonce'))).toBe(false);
    expect(r.run).toBeDefined();
  });

  it('starts Docker Desktop that does not run, waits for it and says so, then goes on', async () => {
    const r = windows((await served()).body, { app: true, env: { STUB_DOCKER: 'stopped' } });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Starting Docker Desktop.');
    expect(r.out).toContain('Waiting for Docker to start.');
    expect(r.run).toBeDefined();
  });

  it('asks for Linux containers when Docker Desktop runs Windows ones', async () => {
    const r = windows((await served()).body, { env: { STUB_OSTYPE: 'windows' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('Switch to Linux containers');
    expect(r.calls.some(c => c.args[0] === 'pull' || c.args[0] === 'run')).toBe(false);
  });

  it('sends a Windows computer that runs the server itself to WSL, as Docker cannot reach localhost', async () => {
    const r = windows((await served({})).body);
    expect(r.code).toBe(1);
    expect(r.out).toContain('Ubuntu terminal of WSL');
    expect(r.calls).toEqual([]);
  });

  it('uses the updater image on this computer when it cannot be downloaded, and stops when it is not here either', async () => {
    const script = (await served()).body;
    const local = windows(script, { env: { STUB_PULL: 'fail', STUB_IMAGE_LOCAL: '1' } });
    expect(local.code).toBe(0);
    expect(local.run).toBeDefined();
    const none = windows(script, { env: { STUB_PULL: 'fail' } });
    expect(none.code).toBe(1);
    expect(none.out).toContain(`Could not download ${UPDATER}. Check the internet connection, then run this command again.`);
    expect(none.run).toBeUndefined();
  });

  it("ends as install.sh ends, which said why itself, and says when the installer does not download", async () => {
    const script = (await served()).body;
    const failed = windows(script, { env: { STUB_INSTALL_EXIT: '1' } });
    expect(failed.code).toBe(1);
    expect(failed.out.trim().split('\n').at(-1)).toMatch(/^machine [0-9a-f]{32}$/);
    const offline = windows(script, { env: { STUB_INSTALL_SH: '' } });
    expect(offline.code).toBe(1);
    expect(offline.out).toContain(`Could not download the installer from ${SERVER}. Check the connection, then run this command again.`);
  });
});
