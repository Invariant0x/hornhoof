#!/usr/bin/env node
// git, as an agent calls it on a node. Everything is real git with its own output and exit code. Only an ordinary push
// of one branch or a fetch of one literal ref goes to the node, which runs real git itself, so that a failure of the
// remote service reaches Hornhoof's failure mechanism from what the node saw and not from anything printed here. The
// commit of a push is fixed before anything runs; a later move of the branch cannot publish another commit.
//
// A call that goes to the node never falls back to a second run once the node took it: the result stays unknown. A call
// the node did not take, for any reason, is plain git, exactly as without this program. An absolute path to git, a PATH
// without this program and programs with their own Git library do not come through here at all.
'use strict';
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const { constants } = require('node:os');
const { resolve } = require('node:path');

/* Every way a push or a fetch stays plain git, with no retry and no wait. */
const UNMANAGED = {
  no_bridge: 'Outside a Hornhoof turn with a bridge: there is no way to reach the node.',
  nested: 'A call from a git hook or from a managed attempt itself.',
  global_option: 'An option before the command other than -C, such as -c or --git-dir.',
  custom_environment: 'GIT_DIR, GIT_SSH_COMMAND and other variables that change what git talks to.',
  force: 'Any force: -f, --force, --force-with-lease, --force-if-includes or a refspec starting with +.',
  delete: 'Deleting a remote ref: -d, --delete or a refspec starting with a colon.',
  multi_ref: 'More than one ref: --all, --mirror, --tags, --prune, several refspecs or a mirror remote.',
  dry_run: '--dry-run, which sends nothing.',
  custom_transport: '--receive-pack, --exec, --repo or --upload-pack.',
  option: 'Any other option: none is taken on trust to mean the same across retries.',
  dynamic_refspec: 'A target only the remote can expand: git fetch, git fetch origin or a glob.',
  url_remote: 'An address or a path instead of a named remote.',
  multi_target: 'A remote with several push addresses.',
  configured_refspec: 'A remote with remote.<name>.push set.',
  no_current_branch: 'A default push without a current branch.',
  no_upstream: 'A default push without an upstream, which git refuses with its own advice.',
  ambiguous_default: 'A default push whose settings do not name exactly one target.',
  unknown_source: 'A source that is no commit here, which git refuses itself.',
  other_ref: 'A tag or another ref outside refs/heads as the source or the target.',
  no_destination: 'A source without a branch name and a target that is not a full ref.',
};

const QUIET_AND_PROGRESS = { '-q': '--quiet', '--quiet': '--quiet', '-v': '--verbose', '--verbose': '--verbose', '--progress': '--progress', '--no-progress': '--no-progress' };
const OPTIONS = {
  push: {
    keep: { ...QUIET_AND_PROGRESS, '--porcelain': '--porcelain', '--no-verify': '--no-verify' },
    refuse: [[/^(-f|--force.*)$/, 'force'], [/^(-d|--delete)$/, 'delete'], [/^--(all|branches|mirror|tags|follow-tags|prune)$/, 'multi_ref'], [/^(-n|--dry-run)$/, 'dry_run'], [/^--(receive-pack|exec|repo)/, 'custom_transport']],
    refspec: [[/^\+/, 'force'], [/^:/, 'delete'], [/\*/, 'dynamic_refspec']],
  },
  fetch: {
    keep: { ...QUIET_AND_PROGRESS, '-n': '--no-tags', '--no-tags': '--no-tags' },
    refuse: [[/^(-f|--force)$/, 'force'], [/^--(all|multiple)$/, 'multi_ref'], [/^--dry-run$/, 'dry_run'], [/^--upload-pack/, 'custom_transport']],
    refspec: [[/^\+/, 'force'], [/^:/, 'dynamic_refspec'], [/\*/, 'dynamic_refspec']],
  },
};
const SET_UPSTREAM = new Set(['-u', '--set-upstream']);
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/* What an ordinary turn sets. Any other GIT_ variable can change the repository or the way out of it. */
const ORDINARY_GIT_ENV = /^GIT_(ASKPASS|TERMINAL_PROMPT|AUTHOR_\w+|COMMITTER_\w+|EDITOR|SEQUENCE_EDITOR|PAGER)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BRANCH_PREFIX = 'refs/heads/';
const STATES = ['ready', 'executing', 'deferred', 'outcome_unknown', 'satisfied', 'failed_permanent', 'cancelled'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROGRESS_LINES = 20;
const PROGRESS_CHARS = 300;
const NOT_KNOWN = 'fatal: Hornhoof lost this git command, and the result of this git command is not known. Check the remote ref before you repeat it.\n';

const unmanaged = reason => ({ kind: 'unmanaged', reason });

function globals(argv, cwd) {
  let at = 0, dir = cwd;
  while (argv[at] === '-C' && argv[at + 1] !== undefined) {
    dir = resolve(dir, argv[at + 1]);
    at += 2;
  }
  return { dir, command: argv[at], rest: argv.slice(at + 1) };
}

function readOptions(kind, args) {
  const { keep, refuse } = OPTIONS[kind];
  const flags = [], positional = [];
  let setUpstream = false;
  for (const arg of args) {
    if (!arg.startsWith('-')) positional.push(arg);
    else if (kind === 'push' && SET_UPSTREAM.has(arg)) setUpstream = true;
    else if (keep[arg]) flags.push(keep[arg]);
    else return { reason: refuse.find(([pattern]) => pattern.test(arg))?.[1] ?? 'option' };
  }
  return { flags, positional, setUpstream };
}

function routeManaged(kind, args, cwd) {
  const options = readOptions(kind, args);
  if (options.reason) return unmanaged(options.reason);
  const [remote = null, ...refspecs] = options.positional;
  if (refspecs.length > 1) return unmanaged('multi_ref');
  const refspec = refspecs[0] ?? null;
  if (kind === 'fetch' && refspec === null) return unmanaged('dynamic_refspec');
  const refused = refspec === null ? null : OPTIONS[kind].refspec.find(([pattern]) => pattern.test(refspec));
  if (refused) return unmanaged(refused[1]);
  const shared = { kind, cwd, remote, refspec, flags: options.flags };
  return kind === 'push' ? { ...shared, setUpstream: options.setUpstream } : shared;
}

/* Reads only the words of the call, so that a git command that is neither a push nor a fetch costs nothing else. */
function routeGit(argv, env, cwd) {
  const { dir, command, rest } = globals(argv, cwd);
  if (command?.startsWith('-')) return unmanaged('global_option');
  if (command !== 'push' && command !== 'fetch') return { kind: 'plain' };
  if (env.HH_GIT_NESTED) return unmanaged('nested');
  if (!env.HH_BRIDGE) return unmanaged('no_bridge');
  if (Object.keys(env).some(name => name.startsWith('GIT_') && !ORDINARY_GIT_ENV.test(name))) return unmanaged('custom_environment');
  return routeManaged(command, rest, dir);
}

const realGit = env => env.HH_REAL_GIT || '/usr/bin/git';

function readerIn(cwd, env) {
  return args => {
    const done = spawnSync(realGit(env), ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...env, HH_GIT_NESTED: '1' } });
    return done.status === 0 ? done.stdout.replace(/\n$/, '') : null;
  };
}

function upstreamDestination(mode, { same, merge, auto }) {
  if (merge === null) return auto ? { destination: same } : { reason: 'no_upstream' };
  return mode === 'simple' && merge !== same ? { reason: 'ambiguous_default' } : { destination: merge };
}

function defaultDestination(mode, facts) {
  if (mode === 'current' || (mode === 'simple' && facts.triangular)) return { destination: facts.same };
  if (facts.triangular || !['simple', 'upstream', 'tracking'].includes(mode)) return { reason: 'ambiguous_default' };
  return upstreamDestination(mode, facts);
}

/* The rules git itself follows for a push without a refspec, read from the settings as they are now. */
function pushSettings(route, branch, git) {
  const config = key => git(['config', '--get', key]);
  const fetchRemote = config(`branch.${branch}.remote`) ?? 'origin';
  const remote = route.remote ?? config(`branch.${branch}.pushRemote`) ?? config('remote.pushDefault') ?? fetchRemote;
  const merge = config(`branch.${branch}.merge`);
  const auto = merge === null && config('push.autoSetupRemote') === 'true';
  return { mode: config('push.default') ?? 'simple', remote, merge, auto, triangular: remote !== fetchRemote, same: `${BRANCH_PREFIX}${branch}` };
}

function defaultTarget(route, git) {
  const branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (branch === null) return { reason: 'no_current_branch' };
  const settings = pushSettings(route, branch, git);
  const target = defaultDestination(settings.mode, settings);
  if (target.reason) return target;
  const sha = git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
  if (sha === null) return { reason: 'unknown_source' };
  return { ...target, remote: settings.remote, sha, branch: route.setUpstream || settings.auto ? branch : null };
}

function explicitDestination(target, full, branch) {
  if (target === undefined) return branch ? { destination: full } : { reason: 'no_destination' };
  if (target.startsWith(BRANCH_PREFIX)) return { destination: target };
  if (target.startsWith('refs/')) return { reason: 'other_ref' };
  return branch ? { destination: `${BRANCH_PREFIX}${target}` } : { reason: 'no_destination' };
}

function explicitTarget(route, git) {
  const [source, target] = route.refspec.split(/:(.*)/s);
  const sha = git(['rev-parse', '--verify', '--quiet', `${source}^{commit}`]);
  if (sha === null) return { reason: 'unknown_source' };
  const full = COMMIT.test(source) ? '' : git(['rev-parse', '--symbolic-full-name', source]) ?? '';
  if (full.startsWith('refs/') && !full.startsWith(BRANCH_PREFIX)) return { reason: 'other_ref' };
  const name = full.startsWith(BRANCH_PREFIX) ? full.slice(BRANCH_PREFIX.length) : null;
  const destination = explicitDestination(target, full, name);
  return destination.reason ? destination : { ...destination, remote: route.remote, sha, branch: route.setUpstream ? name : null };
}

function pushRemoteProblem(remote, git) {
  const urls = git(['remote', 'get-url', '--push', '--all', remote]);
  if (urls === null) return 'url_remote';
  if (urls.includes('\n')) return 'multi_target';
  if (git(['config', '--get-all', `remote.${remote}.push`]) !== null) return 'configured_refspec';
  return git(['config', '--get', `remote.${remote}.mirror`]) === 'true' ? 'multi_ref' : null;
}

function resolvePush(route, git) {
  const target = route.refspec === null ? defaultTarget(route, git) : explicitTarget(route, git);
  if (target.reason) return { unmanaged: target.reason };
  const problem = pushRemoteProblem(target.remote, git);
  if (problem) return { unmanaged: problem };
  return { request: { kind: 'push', cwd: route.cwd, remote: target.remote, sourceSha: target.sha, destinationRef: target.destination, upstreamBranch: target.branch, flags: route.flags } };
}

function resolveFetch(route, git) {
  if (git(['remote', 'get-url', '--all', route.remote]) === null) return { unmanaged: 'url_remote' };
  return { request: { kind: 'fetch', cwd: route.cwd, remote: route.remote, refspec: route.refspec, flags: route.flags } };
}

/* Fixes what the call means now, before anything runs. Later moves of a branch or setting no longer change it. */
function resolveRequest(route, env) {
  if (route.kind === 'unmanaged') return { unmanaged: route.reason };
  const git = readerIn(route.cwd, env);
  return route.kind === 'push' ? resolvePush(route, git) : resolveFetch(route, git);
}

const signalCode = signal => 128 + (constants.signals[signal] ?? 0);
const cleanLine = text => String(text).replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, PROGRESS_CHARS);

/* Only telemetry: anything a command prints can look the same. The node proves an operation by what it owns. */
function markerLine(frame) {
  const known = UUID.test(frame.operationId) && Number.isInteger(frame.generation) && frame.generation > 0 && STATES.includes(frame.state);
  return known ? `hornhoof-git: operation=${frame.operationId} generation=${frame.generation} state=${frame.state}` : null;
}

/* The frames of one operation, in order. Once any arrived the node holds the operation: no second run from here. */
class Frames {
  constructor(io) {
    this.io = io;
    this.pending = '';
    this.seen = 0;
    this.progress = 0;
    this.result = null;
  }

  push(chunk) {
    const lines = (this.pending + chunk).split('\n');
    this.pending = lines.pop();
    for (const line of lines) this.take(line);
  }

  take(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.result = { code: null };
      return;
    }
    if (frame.type === 'unmanaged') this.result = this.seen ? { code: null } : { plain: true };
    else if (frame.type === 'exit') this.result = { code: frame.code ?? signalCode(frame.signal) };
    else this.show(frame);
    this.seen += 1;
  }

  show(frame) {
    if (frame.type === 'stdout') this.io.stdout.write(Buffer.from(String(frame.data), 'base64'));
    else if (frame.type === 'stderr') this.io.stderr.write(Buffer.from(String(frame.data), 'base64'));
    else if (frame.type === 'marker') this.say(markerLine(frame));
    else if (frame.type === 'progress' && this.progress++ < PROGRESS_LINES) this.say(`hornhoof-git: ${cleanLine(frame.text)}`);
  }

  say(line) {
    if (line) this.io.stderr.write(`${line}\n`);
  }

  ended() {
    return this.result ?? { code: null };
  }
}

function askNode(request, env, io) {
  return new Promise((done, failed) => {
    const url = new URL(env.HH_BRIDGE);
    url.pathname = url.pathname.replace('/hook/', '/git/');
    const frames = new Frames(io);
    const call = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hh-pid': String(process.pid) } }, answer => {
      if (answer.statusCode !== 200) {
        answer.resume();
        done({ plain: true });
        return;
      }
      answer.setEncoding('utf8');
      answer.on('data', chunk => frames.push(chunk));
      answer.on('close', () => done(frames.ended()));
    });
    call.on('error', failed);
    call.end(JSON.stringify(request));
  }).catch(() => ({ plain: true }));
}

function plainGit(argv, env, io) {
  return new Promise(done => {
    const child = spawn(realGit(env), argv, { stdio: io.stdio, env });
    const forward = name => child.kill(name);
    for (const name of FORWARDED) process.on(name, forward);
    const finish = code => {
      for (const name of FORWARDED) process.removeListener(name, forward);
      done(code);
    };
    child.once('error', error => {
      io.stderr.write(`git: ${error.message}\n`);
      finish(127);
    });
    child.once('close', (code, signal) => finish(code ?? signalCode(signal)));
  });
}

async function main(argv, env, cwd, io) {
  const route = routeGit(argv, env, cwd);
  if (route.kind === 'plain') return plainGit(argv, env, io);
  const { request } = resolveRequest(route, env);
  if (!request) return plainGit(argv, env, io);
  const answer = await askNode(request, env, io);
  if (answer.plain) return plainGit(argv, env, io);
  if (answer.code === null) io.stderr.write(NOT_KNOWN);
  return answer.code ?? 128;
}

function currentFolder() {
  try {
    return process.cwd();
  } catch {
    /* A folder that is gone is for real git to report, in its own words. */
    return '/';
  }
}

if (require.main === module) {
  /* As a program ends when whoever read its output left; git gets SIGPIPE here. */
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => process.exit(141));
  void main(process.argv.slice(2), process.env, currentFolder(), { stdout: process.stdout, stderr: process.stderr, stdio: 'inherit' }).then(code => {
    process.exitCode = code;
  });
}

module.exports = { UNMANAGED, routeGit, resolveRequest, markerLine, main };
