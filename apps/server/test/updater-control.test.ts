import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { UpdaterControl } from '../src/modules/updates/control.js';
import { JQ, refs, runUpdaterStep, stand, type Stand } from './updater-fixture.js';

const roots: string[] = [];
const STATUS = { id: 'requested-build', version: '0.5.0', state: 'running', step: 'pull', log: '', at: '2026-11-03T10:00:00Z' };

function control() {
  const dir = mkdtempSync(join(tmpdir(), 'updater-control-'));
  roots.push(dir);
  writeFileSync(join(dir, 'status.json'), JSON.stringify(STATUS));
  return { dir, control: new UpdaterControl(dir) };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('the build an updater status describes', () => {
  it('reads the exact requested commit with the same id, even when the version is reused', () => {
    const c = control();
    const commit = 'a'.repeat(40);
    writeFileSync(join(c.dir, 'request.json'), JSON.stringify({ id: STATUS.id, version: STATUS.version, commit }));
    expect(c.control.status()).toEqual({ ...STATUS, commit });
  });

  it('does not attach a newer request to the preceding status', () => {
    const c = control();
    writeFileSync(join(c.dir, 'request.json'), JSON.stringify({ id: 'next-build', version: STATUS.version, commit: 'b'.repeat(40) }));
    expect(c.control.status()).toEqual(STATUS);
  });

  it.each([null, '{invalid', JSON.stringify({ id: STATUS.id, version: STATUS.version })])('keeps old statuses readable without request commit data: %s', data => {
    const c = control();
    if (data !== null) writeFileSync(join(c.dir, 'request.json'), data);
    expect(c.control.status()).toEqual(STATUS);
  });
});

/* The app and the keeper run as UID 1000 and can write the control folder and the keeper's folders in it, so they can
   put a link or a named pipe at any name there. The updater runs as root: a link would have it write over a file only
   root may touch, such as the install's .env, and a pipe nobody writes would stop it for good. Here a synthetic .env
   outside the shared folders stands for such a file. */
const SAMPLE = 'SAMPLE_SETTING=unchanged\n';
function standIn(s: Stand, name = 'sample.env') {
  const path = join(s.dir, 'outside', name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, SAMPLE, { mode: 0o600 });
  return path;
}
const untouched = (path: string) => {
  expect(readFileSync(path, 'utf8')).toBe(SAMPLE);
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
};
const fifo = (path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  expect(spawnSync('mkfifo', [path]).status).toBe(0);
};
const link = (target: string, path: string) => {
  mkdirSync(dirname(path), { recursive: true });
  symlinkSync(target, path);
};
const json = (value: object) => JSON.stringify(value);
const SECRET = `${'A'.repeat(43)}=`;
const DUMP_ID = '0f0f0f0f-0000-4000-8000-00000000000b';
const asksDump = (s: Stand, over: object) => writeFileSync(join(s.control, 'dump.json'), json({ id: DUMP_ID, ...over }));
const ROLE_ENV = `COMPOSE_FILE=compose.worker.yaml\nHORNHOOF_ROLE=data\nPOSTGRES_PASSWORD=${'p'.repeat(24)}\n`;

type Site = {
  /* What the updater writes, in the control folder. */
  name: string;
  /* The names it wrote before it renamed them into place, or wrote in passing, as older builds did. */
  old?: string[];
  /* The name is the request itself, which has to stay a file for the step to run. */
  request?: boolean;
  /* Where a link goes instead, when a link at the name would read as an answer given already. */
  links?: string[];
  step: string;
  prepare?: (s: Stand) => void;
};
const SITES: Site[] = [
  { name: 'host.json', old: ['host.json.new'], step: "docker() { printf 'Sample Linux|sample-host'; }; HOST_OS=''; learn_host" },
  { name: 'addresses.json', old: ['addresses.json.new'], step: 'docker() { :; }; HOST_OS=linux; write_addresses' },
  { name: 'status.json', old: ['status.json.new'], step: 'write_status running pull' },
  { name: 'role.failed', old: ['role.failed.new'], step: 'compose() { :; }; stay_worker sample' },
  {
    name: 'schema/1.done', old: ['schema/1.sql'], links: ['schema/1.sql'], step: "compose() { printf db; }; docker() { case \"$*\" in *pg_tables*) printf 0 ;; *pg_dump*) printf 'sample schema\\n' ;; *) cat > /dev/null ;; esac; }; schema_request",
    prepare: s => writeFileSync(join(s.control, 'schema.json'), json({ attempt: 1, database: 'hornhoof', port: 5432, password: 'sample' })),
  },
  {
    name: 'schema/1.failed', step: 'compose() { return 1; }; schema_request',
    prepare: s => writeFileSync(join(s.control, 'schema.json'), json({ attempt: 1, database: 'hornhoof', port: 5432, only: 'passfile' })),
  },
  {
    name: 'wiped.json', old: ['wiped.json.new', 'wipe.json.new'], step: 'wipe_request',
    prepare: s => {
      writeFileSync(join(s.control, 'wipe.json'), json({ id: 'sample', step: 'done' }));
      writeFileSync(join(s.server, '.env'), ROLE_ENV);
    },
  },
  { name: 'restore-status.json', old: ['restore-status.json.new'], step: 'restore_says running load sample' },
  { name: 'restore-journal.json', old: ['restore-journal.json.new'], step: 'journal saved' },
  {
    name: 'restore-carry.json', old: ['restore-carry.json.new'], step: 'R_ATTEMPT=sample; keep_carry "$TMPDIR/cutover.out"',
    prepare: s => writeFileSync(join(s.dir, 'cutover.out'), `${json({ term: 1 })}\n${json({ people: [] })}\n`),
  },
  {
    name: 'nodes.log', step: 'INSTALLER="$TMPDIR/installer"; worker_nodes',
    prepare: s => {
      writeFileSync(join(s.dir, 'installer'), "printf '%s\\n' 'sample installer output'\n");
      writeFileSync(join(s.server, '.env'), `HORNHOOF_VERSION=0.4.0\n${refs('0.4.0').split(' ').join('\n')}\n`);
    },
  },
  { name: `dumps/${DUMP_ID}.sql.gz`, old: [`dumps/${DUMP_ID}.sql.gz.part`, `dumps/${DUMP_ID}.json.new`], step: 'dump_request', prepare: s => asksDump(s, {}) },
  { name: `dumps/${DUMP_ID}.failed`, old: [`dumps/${DUMP_ID}.failed.new`], links: [`dumps/${DUMP_ID}.failed.new`], step: 'dump_request', prepare: s => asksDump(s, { database: 'sample', reason: 'fork' }) },
  { name: 'uploads/sample.done', step: 'uploads_dir; upload_said sample done' },
  {
    name: 'uploads/sample.tar.gz', old: ['uploads/sample.tar.gz.part'],
    step: "docker() { case \"$*\" in *information_schema*) printf 'public.tasks\\n' ;; *) printf 'id\\n1\\n' ;; esac; }; uploads_dir; make_upload sample db",
  },
  {
    name: 'role.json', request: true, old: ['role-secrets.json'], step: 'data_settings "$(take "$CONTROL/role.json")"',
    prepare: s => {
      writeFileSync(join(s.control, 'role.json'), json({ id: 'sample', secrets: { HORNHOOF_SECRET: SECRET, NODE_KEY: 'k'.repeat(40), RELAY_URL: 'https://relay.sample.test' } }));
      writeFileSync(join(s.server, '.env'), ROLE_ENV);
    },
  },
];
/* What a step that ran wrote where it should. */
const landed = (s: Stand, site: Site) =>
  site.request ? readFileSync(join(s.server, '.env'), 'utf8').includes(`HORNHOOF_SECRET=${SECRET}`) : lstatSync(join(s.control, site.name)).isFile();

describe('what the updater writes in the folders it shares with the app and the keeper', () => {
  it.each(SITES)('writes $name without writing through a link at it or at a name it used on the way', async site => {
    const s = stand();
    site.prepare?.(s);
    const target = standIn(s);
    for (const name of site.links ?? [...(site.old ?? []), ...(site.request ? [] : [site.name])]) link(target, join(s.control, name));
    const r = await runUpdaterStep(s, site.step);
    expect(r.code, r.out).toBe(0);
    untouched(target);
    expect(landed(s, site), r.out).toBe(true);
  });

  it.each(SITES)('writes $name at once with a named pipe at it or at a name it used on the way', async site => {
    const s = stand();
    site.prepare?.(s);
    for (const name of [...(site.old ?? []), ...(site.request ? [] : [site.name])]) fifo(join(s.control, name));
    const r = await runUpdaterStep(s, site.step);
    expect(r.code, r.out).toBe(0);
    expect(landed(s, site), r.out).toBe(true);
  }, 8_000);

  it.each(SITES.filter(site => !site.request))('writes $name as a whole file, then renames it into place', async site => {
    const s = stand();
    site.prepare?.(s);
    const r = await runUpdaterStep(s, site.step);
    expect(r.code, r.out).toBe(0);
    expect(lstatSync(join(s.control, site.name)).isFile()).toBe(true);
    /* No private folder, no file on the way, stays behind. */
    const folder = dirname(join(s.control, site.name));
    expect(readdirSync(folder).filter(name => name.startsWith('.') || name.endsWith('.new') || name.endsWith('.part'))).toEqual([]);
  });

  /* The keeper's folders are made by root, then handed to the keeper. One the app swapped for a link to another folder
     is no keeper's folder: nothing of it changes, and nothing is written into it. */
  it.each([
    { folder: 'dumps', step: 'dump_request', prepare: (s: Stand) => asksDump(s, {}) },
    { folder: 'dumps', step: 'dump_request', prepare: (s: Stand) => asksDump(s, { database: 'sample', reason: 'fork' }) },
    { folder: 'uploads', step: 'if uploads_dir; then upload_said sample done; fi' },
    { folder: 'schema', step: 'compose() { return 1; }; schema_request', prepare: (s: Stand) => writeFileSync(join(s.control, 'schema.json'), json({ attempt: 1, database: 'hornhoof', port: 5432 })) },
  ])('changes nothing of a folder linked in the place of $folder', async ({ folder, step, prepare }) => {
    const s = stand();
    prepare?.(s);
    const outside = join(s.dir, 'outside-folder');
    mkdirSync(outside, { mode: 0o755 });
    chmodSync(outside, 0o755);
    symlinkSync(outside, join(s.control, folder));
    const r = await runUpdaterStep(s, step);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`Refused ${folder}: it is not a plain folder.`);
    expect(readdirSync(outside)).toEqual([]);
    expect(lstatSync(outside).mode & 0o777).toBe(0o755);
  });

  it('leaves a link at the app heartbeat and what it points to alone', async () => {
    const s = stand();
    const made = join(s.dir, 'outside', 'made-by-root');
    mkdirSync(dirname(made), { recursive: true });
    symlinkSync(made, join(s.control, 'alive'));
    const r = await runUpdaterStep(s, 'heartbeats');
    expect(r.code, r.out).toBe(0);
    expect(existsSync(made)).toBe(false);
    expect(lstatSync(join(s.control, 'alive')).isSymbolicLink()).toBe(true);
  });

  it('publishes a fresh heartbeat inode in both volumes', async () => {
    const s = stand();
    const app = join(s.control, 'alive');
    const keeper = join(s.computerControl, 'alive');
    writeFileSync(app, '');
    writeFileSync(keeper, '');
    const before = [lstatSync(app).ino, lstatSync(keeper).ino];
    const r = await runUpdaterStep(s, 'heartbeats');
    expect(r.code, r.out).toBe(0);
    expect(lstatSync(app).ino).not.toBe(before[0]);
    expect(lstatSync(keeper).ino).not.toBe(before[1]);
  });
});

/* What the updater reads in the shared folders it reads only as a regular file of that folder, and nothing else. */
type Read = { name: string; step: string; standIn: object };
const READS: Read[] = [
  { name: 'status.json', step: "if update_running; then printf 'read: running\\n'; fi", standIn: { state: 'running' } },
  { name: 'go.json', step: "ID=sample TAG=0.4.1; if told_to_go; then printf 'read: go\\n'; fi", standIn: { id: 'sample', commit: '0.4.1', until: 9_999_999_999 } },
  { name: 'promised.json', step: "ID=sample; printf 'read: %s\\n' \"$(keeper_said promised.json ok || true)\"", standIn: { id: 'sample', ok: true } },
  { name: 'restore-status.json', step: "restore_request; printf 'read: %s\\n' \"$R_ATTEMPT\"", standIn: { state: 'running', step: 'load', attempt: 'sample', id: 'sample' } },
];

describe('what the updater reads in the folders it shares with the app and the keeper', () => {
  it('reports a request that is a directory', async () => {
    const s = stand();
    mkdirSync(join(s.control, 'request.json'));
    const r = await runUpdaterStep(s, 'handle_request');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused request.json: it is not a plain file.');
  });

  it.each(READS)('refuses $name when it is a link, and reads nothing through it', async ({ name, step, standIn: said }) => {
    const s = stand();
    const outside = join(s.dir, 'outside', name);
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, json(said), { mode: 0o600 });
    symlinkSync(outside, join(s.control, name));
    const r = await runUpdaterStep(s, step);
    expect(r.out).toContain(`Refused ${name}: it is not a plain file.`);
    expect(r.out).not.toMatch(/read: [a-z]/);
  });

  it.each(READS)('goes on at once with a named pipe at $name', async ({ name, step }) => {
    const s = stand();
    fifo(join(s.control, name));
    const r = await runUpdaterStep(s, step);
    expect(r.out).toContain(`Refused ${name}: it is not a plain file.`);
  }, 8_000);

  it('goes on at once with a named pipe at the computer access file', async () => {
    const s = stand();
    fifo(join(s.computerControl, 'computer.json'));
    const r = await runUpdaterStep(s, "if computer_open; then printf 'read: open\\n'; fi");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused computer.json: it is not a plain file.');
  }, 8_000);

  it('reads a regular file as it is', async () => {
    const s = stand();
    writeFileSync(join(s.control, 'status.json'), json({ state: 'running' }));
    const r = await runUpdaterStep(s, "if update_running; then printf 'read: running\\n'; fi");
    expect(r.out).toContain('read: running');
    expect(readdirSync(s.control)).toEqual(['status.json']);
  });

  /* What root publishes there is root's, with one name, and everyone may read it. Where Linux lets anyone give a file a
     second name (fs.protected_hardlinks=0, its default without systemd), only such a file of root's is taken: one only
     root may read could be another of root's files under the name. */
  it.each([
    { why: 'where hard links are protected', protect: 'return 0', taken: ['7 1 644 0', '8 1 600 0'], refused: ['9 2 644 0'] },
    { why: 'where anyone may link any file', protect: 'return 1', taken: ['7 1 644 0', '6 1 4755 0'], refused: ['8 1 600 0', '5 1 640 0', '9 2 644 0'] },
  ])('takes a file of root with one name $why, and only what everyone may read where anyone may link', async ({ protect, taken, refused }) => {
    const s = stand();
    const after = (facts: string) => facts.replace(/^(\S+) (\d+)/, (_, inode: string, links: string) => `${inode} ${Number(links) + 1}`);
    const step = [
      `hardlinks_protected() { ${protect}; }`,
      ...taken.map(facts => `same_file '${facts}' '${after(facts)}' 1000 && printf 'taken: %s\\n' '${facts}'`),
      ...refused.map(facts => `same_file '${facts}' '${after(facts)}' 1000 || printf 'refused: %s\\n' '${facts}'`),
      'true',
    ].join('\n');
    const r = await runUpdaterStep(s, step);
    expect(r.code, r.out).toBe(0);
    expect(r.out.split('\n').filter(Boolean).sort()).toEqual([...taken.map(facts => `taken: ${facts}`), ...refused.map(facts => `refused: ${facts}`)].sort());
  });

  /* The second name is made on the file system of the shared folder itself. Where it cannot be made, as across file
     systems (EXDEV), or is not of the file that was looked at, or the file is nobody's it may be, nothing is read. */
  function tool(s: Stand, name: string, script: string) {
    const tools = join(s.dir, 'tools');
    mkdirSync(tools, { recursive: true });
    writeFileSync(join(tools, name), `#!/bin/sh\n${script}`, { mode: 0o755 });
    return { PATH: `${tools}:${dirname(fileURLToPath(new URL('./updater-stubs/docker', import.meta.url)))}:${dirname(JQ)}:/usr/bin:/bin` };
  }
  it.each([
    { why: 'a second name across file systems', name: 'ln', script: "printf 'ln: failed to create hard link: Invalid cross-device link\\n' >&2\nexit 1\n" },
    { why: 'a second name of another file', name: 'ln', script: 'last=\nfor a in "$@"; do last=$a; done\nexec /bin/ln -- "$STAND_IN" "$last"\n' },
    { why: 'an owner who is neither root nor the folder owner', name: 'stat', script: 'out=$(/usr/bin/stat "$@") || exit\ncase "$*" in *taken) printf \'%s 4242\\n\' "${out% *}" ;; *) printf \'%s\\n\' "$out" ;; esac\n' },
    { why: 'no name more than it had', name: 'stat', script: 'out=$(/usr/bin/stat "$@") || exit\ncase "$*" in *taken) set -- $out; inode=$1 links=$2; shift 2; printf \'%s %s %s\\n\' "$inode" "$((links - 1))" "$*" ;; *) printf \'%s\\n\' "$out" ;; esac\n' },
  ])('reads nothing by $why', async ({ name, script }) => {
    const s = stand();
    const other = join(s.control, 'other.json');
    writeFileSync(other, json({ state: 'running' }));
    writeFileSync(join(s.control, 'status.json'), json({ state: 'running' }));
    const r = await runUpdaterStep(s, "if update_running; then printf 'read: running\\n'; fi", { ...tool(s, name, script), STAND_IN: other });
    expect(r.out).toContain('Refused status.json: it is not a plain file.');
    expect(r.out).not.toContain('read: running');
    expect(readdirSync(s.control).sort()).toEqual(['other.json', 'status.json']);
  });
});

/* An installer the updater runs reads the machine's addresses in its control folder, as install.sh does to warn of a
   subnet that covers the machine's own network. It is given a folder of the updater's own instead, with the addresses
   taken from the shared one, so it opens nothing the app or the keeper put there. */
describe('the control folder of an installer the updater runs', () => {
  const READER = 'f="${HORNHOOF_CONTROL_DIR:-/control}/addresses.json"\nif [ -r "$f" ]; then printf \'read: %s\\n\' "$(grep -oE \'[0-9]+[.][0-9]+[.][0-9]+[.][0-9]+\' "$f" | tr \'\\n\' \' \')"; fi\n';
  const RUNS = [
    { how: 'for the nodes of a worker', step: 'INSTALLER="$TMPDIR/installer"; worker_nodes; cat "$CONTROL/nodes.log"' },
    { how: 'for an update', step: 'WORK="$TMPDIR/work"; mkdir -p "$WORK/0.4.1"; cp "$TMPDIR/installer" "$WORK/0.4.1/install.sh"; run_installer 0.4.1 app node updater; cat "$WORK/install.log"' },
  ];
  function installer(s: Stand) {
    writeFileSync(join(s.dir, 'installer'), READER);
    writeFileSync(join(s.server, '.env'), `HORNHOOF_VERSION=0.4.0\n${refs('0.4.0').split(' ').join('\n')}\n`);
  }

  it.each(RUNS)('gives it the addresses the updater wrote, $how', async ({ step }) => {
    const s = stand();
    installer(s);
    writeFileSync(join(s.control, 'addresses.json'), json({ at: 1, addresses: ['192.0.2.10'] }));
    const r = await runUpdaterStep(s, step);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('read: 192.0.2.10');
  });

  it.each(RUNS)('gives it nothing through a link at them, $how', async ({ step }) => {
    const s = stand();
    installer(s);
    const outside = join(s.dir, 'outside.json');
    writeFileSync(outside, json({ addresses: ['198.51.100.7'] }), { mode: 0o600 });
    symlinkSync(outside, join(s.control, 'addresses.json'));
    const r = await runUpdaterStep(s, step);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused addresses.json: it is not a plain file.');
    expect(r.out).not.toContain('198.51.100.7');
  });

  it.each(RUNS)('runs it at once with a named pipe at them, $how', async ({ step }) => {
    const s = stand();
    installer(s);
    fifo(join(s.control, 'addresses.json'));
    const r = await runUpdaterStep(s, step);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('Refused addresses.json: it is not a plain file.');
  }, 8_000);
});
