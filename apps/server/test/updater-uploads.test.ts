import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { beforeAll, describe, expect, it } from 'vitest';
import { APP, DIGESTS, JQ, runOnce, runUpdaterStep, stand, UPDATER_DIGESTS, type Stand } from './updater-fixture.js';

/* A machine that keeps a copy of the company's data, and the company server it uploads to. */
const OWN_IMAGE = `${APP}-updater@${UPDATER_DIGESTS['0.4.0']}`;
const COPY = {
  HORNHOOF_ROLE: 'data',
  HORNHOOF_HEALTH_URL: 'http://keeper:7080/api/keeper',
  STUB_SERVICES: 'front keeper db migrate app updater',
  STUB_RUNNING_IMAGES: `keeper=${APP}@${DIGESTS['0.4.0']} updater=${OWN_IMAGE}`,
  STUB_OWN_IMAGE: OWN_IMAGE,
  STUB_LOG_ROLE: '1',
};
const SECRETS = { HORNHOOF_SECRET: Buffer.alloc(32, 7).toString('base64'), NODE_KEY: 'n'.repeat(44), RELAY_URL: 'https://relay.hornhoof.test', POSTGRES_PASSWORD: 'p'.repeat(24) };
const COPY_ENV =
  `COMPOSE_FILE=compose.yaml:compose.worker.yaml\nHORNHOOF_ROLE=data\nHORNHOOF_SECRET=${SECRETS.HORNHOOF_SECRET}\nNODE_KEY=${SECRETS.NODE_KEY}\nHORNHOOF_VERSION=0.4.0\n` +
  `RELAY_URL=${SECRETS.RELAY_URL}\nPOSTGRES_PASSWORD=${SECRETS.POSTGRES_PASSWORD}\nCOMPOSE_PROFILES=data,builtin\n`;
const TABLES = ['net.journal', 'net_local.state', 'public.agents', 'public.tasks'];
const NID = `99bb2233aabbccdd${'2'.repeat(48)}`;
const DATABASE = 'hornhoof_upload_99bb2233aabbccdd_20261111t120005';
const LOADING = 'hornhoof_uploading_99bb2233aabbccdd_20261111t120005';

const has = (s: Stand, name: string) => existsSync(join(s.control, name));
const listed = (s: Stand, name: string) => (has(s, name) ? readdirSync(join(s.control, name)).sort() : []);
const modeOf = (s: Stand, name: string) => statSync(join(s.control, name)).mode & 0o777;
const envOf = (s: Stand): Record<string, string> =>
  Object.fromEntries(readFileSync(join(s.server, '.env'), 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
/* Every word any command was given, everything the updater said, and every file it left in the control folder. */
const everything = (s: Stand, r: { out: string; calls: string[] }) => [r.out, ...r.calls, ...readdirSync(s.control).map(name => (statSync(join(s.control, name)).isFile() ? readFileSync(join(s.control, name), 'utf8') : ''))].join('\n');
const namesIn = (file: string) => spawnSync('tar', ['-tzf', file], { encoding: 'utf8' }).stdout.trim().split('\n').sort();

/* A packed upload as a machine sends one: the files of a folder the test filled, under the names the test gives. */
function packed(s: Stand, id: string, files: Record<string, string>, more: (dir: string) => string[] = () => []): string {
  const dir = mkdtempSync(join(s.dir, 'packing-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const extra = more(dir);
  mkdirSync(join(s.control, 'uploads'), { recursive: true });
  const file = join(s.control, 'uploads', `${NID}-${id}.tar.gz`);
  /* The names go in as they are given: GNU tar would take the way out of the folder off a name. */
  const made = spawnSync('tar', ['-czPf', file, '-C', dir, ...Object.keys(files), ...extra], { encoding: 'utf8' });
  if (!existsSync(file)) throw new Error(`The test could not pack an upload: ${made.stderr}`);
  return file;
}
/* BusyBox tar, which the updater's image has, lists a second name of a file as a plain file ("-rw-r--r-- ... name -> first",
   where GNU tar starts the line with h), and makes it even to a file outside the folder. The updater runs it instead. */
const TAR = spawnSync('sh', ['-c', 'command -v tar'], { encoding: 'utf8' }).stdout.trim();
const busyboxTar = (s: Stand) => {
  const tools = mkdtempSync(join(s.dir, 'tools-'));
  writeFileSync(join(tools, 'tar'), `#!/bin/sh\ncase "$1" in -tvf) ${TAR} "$@" | sed 's/^h/-/' ;; *) exec ${TAR} "$@" ;; esac\n`, { mode: 0o755 });
  return { PATH: `${tools}:${dirname(fileURLToPath(new URL('./updater-stubs/docker', import.meta.url)))}:${dirname(JQ)}:/usr/bin:/bin` };
};
/* The same, also writing down every command it is given, so a test sees whether anything was unpacked at all. */
const loggedTar = (s: Stand) => {
  const tools = mkdtempSync(join(s.dir, 'tools-'));
  const log = join(s.dir, 'tar.log');
  writeFileSync(join(tools, 'tar'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\ncase "$1" in -tvf) ${TAR} "$@" | sed 's/^h/-/' ;; *) exec ${TAR} "$@" ;; esac\n`, { mode: 0o755 });
  return { env: { PATH: `${tools}:${dirname(fileURLToPath(new URL('./updater-stubs/docker', import.meta.url)))}:${dirname(JQ)}:/usr/bin:/bin` }, calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
};
/* A tar archive written header by header, for members no tar of this machine would pack as they are. */
type Member = { name: string; type?: string; data?: string; link?: string; prefix?: string } | { block: Buffer };
function tarOf(members: Member[]): Buffer {
  const blocks: Buffer[] = [];
  for (const member of members) {
    if ('block' in member) {
      blocks.push(member.block);
      continue;
    }
    const { name, type = '0', data = '', link = '', prefix = '' } = member;
    const header = Buffer.alloc(512);
    const body = Buffer.from(data);
    const put = (at: number, value: string) => header.write(value, at, 'latin1');
    put(0, name);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, `${body.length.toString(8).padStart(11, '0')}\0`);
    put(136, '00000000000\0');
    put(148, '        ');
    put(156, type);
    put(157, link);
    put(257, 'ustar\x0000');
    put(345, prefix);
    let sum = 0;
    for (const byte of header) sum += byte;
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
/* A pax header's record: its length counts itself. */
const pax = (key: string, value: string) => {
  const rest = ` ${key}=${value}\n`;
  let length = rest.length + 1;
  while (`${length}${rest}`.length !== length) length += 1;
  return `${length}${rest}`;
};
const TASKS = 'id,title\n1,first\n2,"two\n\\.\nDROP DATABASE hornhoof;"\n';
const JOURNAL = 'id,tbl\n7,tasks\n';
const load = (s: Stand, id: string, file: string, over: object = {}) =>
  writeFileSync(join(s.control, 'load.json'), JSON.stringify({ id, machine: randomUUID(), file, database: DATABASE, unpackMax: 1024 * 1024, ...over }), { mode: 0o600 });
const copies = (calls: string[]) => calls.filter(c => c.includes('\\copy '));
const renamed = (calls: string[]) => calls.some(c => c.includes(' RENAME TO hornhoof_upload_'));
const made = (calls: string[]) => calls.some(c => c.includes('CREATE DATABASE'));

describe('the updater and what a machine held when it stopped holding the data', () => {
  beforeAll(() => {
    if (!JQ) throw new Error('The updater tests need jq. Install it (brew install jq on a Mac, apt install jq on Debian or Ubuntu), then run them again.');
  });

  it('makes an upload as CSV', async () => {
    const s = stand(COPY_ENV);
    const id = randomUUID();
    const ask = () => {
      writeFileSync(join(s.control, 'replica.json'), '{}');
      writeFileSync(join(s.control, 'upload.json'), JSON.stringify({ id }), { mode: 0o600 });
    };
    ask();
    const r = await runOnce(s, null, COPY);
    /* Each table of the company's three schemas, of the database in use alone, with its header. */
    const read = r.calls.filter(c => c.includes(' TO STDOUT '));
    expect(read).toEqual(TABLES.map(table => `docker exec dbcid psql -U hornhoof -d hornhoof -v ON_ERROR_STOP=1 -q -c COPY "${table.split('.')[0]}"."${table.split('.')[1]}" TO STDOUT (FORMAT csv, HEADER true)`));
    expect(namesIn(join(s.control, 'uploads', `${id}.tar.gz`))).toEqual(TABLES.map(table => `${table}.csv`));
    expect(listed(s, 'uploads')).toEqual([`${id}.done`, `${id}.tar.gz`]);
    expect([modeOf(s, 'uploads'), modeOf(s, `uploads/${id}.tar.gz`), modeOf(s, `uploads/${id}.done`)]).toEqual([0o700, 0o600, 0o600]);
    expect(has(s, 'upload.json')).toBe(false);
    /* The same request again makes nothing again: its answer is there. */
    ask();
    const again = await runOnce(s, null, COPY);
    expect(again.calls.filter(c => c.includes(' TO STDOUT '))).toHaveLength(TABLES.length);
    expect(has(s, 'upload.json')).toBe(false);

    /* A table that cannot be read leaves a line, and nothing of the upload. */
    const broken = stand(COPY_ENV);
    writeFileSync(join(broken.control, 'replica.json'), '{}');
    writeFileSync(join(broken.control, 'upload.json'), JSON.stringify({ id }));
    const failed = await runOnce(broken, null, { ...COPY, STUB_COPY_OUT: 'fail' });
    expect(listed(broken, 'uploads')).toEqual([`${id}.failed`]);
    expect(readFileSync(join(broken.control, 'uploads', `${id}.failed`), 'utf8').trim()).toBe('A table could not be read.');
    expect(failed.out).toContain("Could not make the upload of this machine's copy: A table could not be read.");
    expect(has(broken, 'upload.json')).toBe(false);

    /* A request that names what no id is called is dropped, and a company server makes no upload. */
    const odd = stand(COPY_ENV);
    writeFileSync(join(odd.control, 'replica.json'), '{}');
    writeFileSync(join(odd.control, 'upload.json'), JSON.stringify({ id: '../x' }));
    expect((await runOnce(odd, null, COPY)).calls.some(c => c.includes(' TO STDOUT '))).toBe(false);
    expect(has(odd, 'upload.json')).toBe(false);
    const server = stand();
    writeFileSync(join(server.control, 'upload.json'), JSON.stringify({ id }));
    expect((await runOnce(server, null)).calls.some(c => c.includes(' TO STDOUT '))).toBe(false);
  });

  it('loads an upload as data alone', async () => {
    const s = stand();
    const id = randomUUID();
    const file = packed(s, id, { 'public.tasks.csv': TASKS, 'net.journal.csv': JOURNAL });
    load(s, id, file);
    const r = await runOnce(s, null);
    /* A database of its own, with this server's own schema. */
    const create = r.calls.findIndex(c => c === `docker exec dbcid psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c CREATE DATABASE ${LOADING}`);
    const schema = r.calls.findIndex(c => c === 'docker exec dbcid pg_dump -U hornhoof --schema-only --no-owner --no-privileges --no-publications --no-subscriptions -d hornhoof');
    const into = r.calls.findIndex(c => c === `docker exec -i dbcid psql -U hornhoof -1 -v ON_ERROR_STOP=1 -d ${LOADING}`);
    expect(create).toBeGreaterThanOrEqual(0);
    expect(schema).toBeGreaterThan(create);
    expect(into).toBeGreaterThan(schema);
    /* With the count of its migrations, so a bundle of it says what schema it is of. */
    expect(r.calls.slice(schema, into)).toContain('docker exec dbcid pg_dump -U hornhoof --data-only --table=drizzle.__drizzle_migrations -d hornhoof');
    /* Each file goes in as the rows of its table, by the columns its header names, with no trigger run. */
    const copy = (table: string, columns: string) =>
      `docker exec -e PGOPTIONS=-c session_replication_role=replica -i dbcid psql -U hornhoof -d ${LOADING} -v ON_ERROR_STOP=1 -q -c \\copy ${table} (${columns}) FROM STDIN WITH (FORMAT csv, HEADER true)`;
    expect(copies(r.calls)).toEqual([copy('"net"."journal"', '"id", "tbl"'), copy('"public"."tasks"', '"id", "title"')]);
    expect(r.calls.indexOf(copies(r.calls)[0]!)).toBeGreaterThan(into);
    expect(readFileSync(join(s.dir, 'copied-public.tasks'), 'utf8')).toBe(TASKS);
    expect(readFileSync(join(s.dir, 'copied-net.journal'), 'utf8')).toBe(JOURNAL);
    /* Only then does it get the name the merge looks for. */
    const rename = r.calls.findIndex(c => c === `docker exec dbcid psql -U hornhoof -d postgres -v ON_ERROR_STOP=1 -q -c ALTER DATABASE ${LOADING} RENAME TO ${DATABASE}`);
    expect(rename).toBeGreaterThan(r.calls.indexOf(copies(r.calls)[1]!));
    expect(existsSync(join(s.dir, `db-${DATABASE}`))).toBe(true);
    expect(listed(s, 'uploads')).toEqual([`${NID}-${id}.done`]);
    expect(modeOf(s, `uploads/${NID}-${id}.done`)).toBe(0o600);
    expect(has(s, 'load.json')).toBe(false);
    /* Nothing the machine sent stands in a command or in what was said. */
    const all = everything(s, r);
    for (const line of ['DROP DATABASE hornhoof;', '1,first', '7,tasks']) expect(all.includes(line), line).toBe(false);
    /* The same request again loads nothing again. */
    load(s, id, file);
    const again = await runOnce(s, null);
    expect(copies(again.calls)).toHaveLength(2);
    expect(has(s, 'load.json')).toBe(false);
  });

  /* The keeper takes what a machine sends into a folder the app can write too. A named pipe in the place of the packed
     file stops nothing, and the load unpacks and dumps the schema in a folder of the updater's own, never through a
     link put at the names it used for that in the shared folder. */
  /* Every member is looked at in the archive's own headers before tar touches anything: tar's own listing can show a
     second name of a file, even one outside the folder, as a plain file, and BusyBox tar makes such a name as it unpacks.
     Only plain files go, and tar unpacks none of an upload that holds anything else. */
  it.each<{ what: string; members: (out: string) => Member[]; line: string }>([
    { what: 'a second name of a file outside the folder', members: (out: string) => [{ name: 'net.journal.csv', type: '1', link: out }], line: 'The upload holds what is no file.' },
    { what: 'a plain file that names a link, which BusyBox makes a second name of', members: (out: string) => [{ name: 'net.journal.csv', link: out }], line: 'The upload holds what is no file.' },
    { what: 'a link', members: (out: string) => [{ name: 'net.journal.csv', type: '2', link: out }], line: 'The upload holds what is no file.' },
    { what: 'a folder', members: () => [{ name: 'net.journal.csv', type: '5' }], line: 'The upload holds what is no file.' },
    { what: 'a named pipe', members: () => [{ name: 'net.journal.csv', type: '6' }], line: 'The upload holds what is no file.' },
    { what: 'a device', members: () => [{ name: 'net.journal.csv', type: '3' }], line: 'The upload holds what is no file.' },
    { what: 'a file of a kind this updater never packs', members: () => [{ name: 'net.journal.csv', type: '7', data: JOURNAL }], line: 'The upload holds what is no file.' },
    { what: 'a file with no kind at all, as the oldest tars wrote one', members: () => [{ name: 'net.journal.csv', type: '\0', data: JOURNAL }], line: 'The upload holds what is no file.' },
    { what: 'a name with a folder before it', members: () => [{ name: 'net.journal.csv', prefix: 'public.tasks', data: JOURNAL }], line: 'The upload holds what is no file.' },
    {
      what: 'a header that gives the next file another name',
      members: () => [{ name: 'public.pax.csv', type: 'x', data: pax('path', 'net.journal.csv') }, { name: 'public.other.csv', data: JOURNAL }],
      line: 'The upload holds what is no file.',
    },
    { what: 'a table twice', members: () => [{ name: 'public.tasks.csv', data: TASKS }], line: 'The upload holds a table twice.' },
    /* Tar reads on past one empty block, or stops at it, as it is made: after one, only empty blocks may follow. */
    { what: 'a link after one empty block', members: (out: string) => [{ block: Buffer.alloc(512) }, { name: 'net.journal.csv', type: '1', link: out }], line: 'The upload cannot be read.' },
    { what: 'something after its end', members: () => [{ block: Buffer.alloc(1024) }, { block: Buffer.alloc(512, 'x') }], line: 'The upload cannot be read.' },
    /* Each header is read on its own, so an upload of more files than the company could ever have tables is not read on. */
    { what: 'more files than the company could have tables', members: () => Array.from({ length: 1000 }, (_, i) => ({ name: `public.t${i}.csv` })), line: 'The upload holds a file that is no table of the company.' },
  ])('unpacks nothing of an upload that holds $what', async ({ members, line }) => {
    const s = stand();
    const id = randomUUID();
    const outside = join(s.dir, 'outside.csv');
    writeFileSync(outside, JOURNAL, { mode: 0o600 });
    mkdirSync(join(s.control, 'uploads'), { recursive: true });
    const file = join(s.control, 'uploads', `${NID}-${id}.tar.gz`);
    writeFileSync(file, gzipSync(tarOf([{ name: 'public.tasks.csv', data: TASKS }, ...members(outside)])));
    load(s, id, file);
    const tar = loggedTar(s);
    const r = await runOnce(s, null, tar.env);
    expect(readFileSync(join(s.control, 'uploads', `${NID}-${id}.failed`), 'utf8').trim()).toBe(line);
    expect(r.out).toContain(`Could not load what a machine uploaded: ${line}`);
    expect(tar.calls().filter(call => /^-\w*x/.test(call))).toEqual([]);
    expect([readFileSync(outside, 'utf8'), statSync(outside).nlink]).toEqual([JOURNAL, 1]);
    expect(made(r.calls)).toBe(false);
  });

  /* Where the limit is: the headers of a thousand files are read, and none of one more. */
  /* A file of 8 GiB or more has its size written in base-256, as GNU and BusyBox tar write it: the byte 0x80, then the
     number in the eleven bytes after it. Such a table is read as the plain file it is. A size in any other such form, or
     larger than what follows its header, is not read at all. Nor is anything but zeros after the end, also so far into
     the archive that BusyBox tail, which the updater's image has, takes no number that large: tail here is as limited.
     The archives are sparse: the table's bytes take no room. */
  it('reads the size of a table of 8 GiB and more, and no size it cannot be sure of', async () => {
    const s = stand();
    const OVER = 8 * 1024 ** 3 + 512;
    const base256 = (first: number, value: bigint) => {
      const field = Buffer.alloc(12);
      field[0] = first;
      for (let i = 11, v = value; i > 0; i -= 1, v >>= 8n) field[i] = Number(v & 0xffn);
      return field;
    };
    /* One plain table with the size field given, then as many bytes as it says, rounded to blocks, or fewer, the two
       empty blocks that end an archive, and what comes after them. */
    const sparse = (name: string, field: Buffer, bytes = OVER, after = '') => {
      const header = tarOf([{ name: 'public.tasks.csv' }]).subarray(0, 512);
      field.copy(header, 124);
      header.fill(' ', 148, 156);
      let sum = 0;
      for (const byte of header) sum += byte;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
      const fd = openSync(join(s.dir, `${name}.tar`), 'w');
      writeSync(fd, header);
      ftruncateSync(fd, 512 + Math.ceil(bytes / 512) * 512 + 1024);
      if (after) writeSync(fd, after, 512 + Math.ceil(bytes / 512) * 512 + 1024);
      closeSync(fd);
    };
    sparse('over', base256(0x80, BigInt(OVER)));
    sparse('short', base256(0x80, BigInt(OVER)), OVER - 4096);
    sparse('negative', base256(0xff, BigInt(OVER)));
    sparse('flagged', base256(0x81, BigInt(OVER)));
    sparse('huge', base256(0x80, (1n << 88n) - 1n));
    sparse('trailing', base256(0x80, BigInt(OVER)), OVER, 'x'.repeat(512));
    /* The same past the end of a table of 5 GiB, its size in octal. */
    sparse('octal', Buffer.from('50000000000\0', 'latin1'), 5 * 1024 ** 3, 'x'.repeat(512));
    const tools = mkdtempSync(join(s.dir, 'tools-'));
    const TAIL = spawnSync('sh', ['-c', 'command -v tail'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(
      join(tools, 'tail'),
      `#!/bin/sh\nfor a in "$@"; do n=\${a#+}; case "$n" in *[!0-9]* | '') ;; *) [ "$n" -lt 4294967296 ] || { echo "tail: invalid number '$a'" >&2; exit 1; } ;; esac; done\nexec ${TAIL} "$@"\n`,
      { mode: 0o755 },
    );
    const r = await runUpdaterStep(
      s,
      `for f in over short negative flagged huge trailing octal; do e=0; m=$(tar_members "${s.dir}/$f.tar") || e=$?; printf '%s %s %s\\n' "$f" "$e" "$m"; done`,
      { PATH: `${tools}:${dirname(fileURLToPath(new URL('./updater-stubs/docker', import.meta.url)))}:${dirname(JQ)}:/usr/bin:/bin` },
    );
    expect(r.out.split('\n').filter(Boolean)).toEqual(['over 0 file public.tasks.csv', 'short 1 ', 'negative 1 ', 'flagged 1 ', 'huge 1 ', 'trailing 1 file public.tasks.csv', 'octal 1 file public.tasks.csv']);
  });

  it('reads the headers of a thousand files of an upload, and not one more', async () => {
    const s = stand();
    const files = (n: number) => tarOf(Array.from({ length: n }, (_, i) => ({ name: `public.t${i}.csv` })));
    writeFileSync(join(s.dir, 'most.tar'), files(1000));
    writeFileSync(join(s.dir, 'over.tar'), files(1001));
    const r = await runUpdaterStep(
      s,
      `for f in most over; do e=0; m=$(tar_members "${s.dir}/$f.tar") || e=$?; printf '%s %s %s\\n' "$f" "$(printf '%s\\n' "$m" | grep -c '^file ')" "$e"; done`,
    );
    expect(r.out.trim().split('\n')).toEqual(['most 1000 0', 'over 1000 2']);
  });

  it('loads nothing from a named pipe in the place of an upload, and goes on at once', async () => {
    const s = stand();
    const id = randomUUID();
    const file = join(s.control, 'uploads', `${NID}-${id}.tar.gz`);
    mkdirSync(join(s.control, 'uploads'), { recursive: true });
    expect(spawnSync('mkfifo', [file]).status).toBe(0);
    load(s, id, file);
    const r = await runOnce(s, null);
    expect(r.out).toContain(`Refused ${NID}-${id}.tar.gz: it is not a plain file.`);
    expect(listed(s, 'uploads')).toEqual([`${NID}-${id}.failed`]);
    expect(copies(r.calls)).toEqual([]);
    expect(renamed(r.calls)).toBe(false);
  }, 10_000);

  it('loads an upload without writing through links at the names an older build unpacked it at', async () => {
    const s = stand();
    const id = randomUUID();
    const file = packed(s, id, { 'public.tasks.csv': TASKS });
    const outside = join(s.dir, 'outside');
    mkdirSync(outside);
    const sample = join(outside, 'sample.env');
    writeFileSync(sample, 'SAMPLE_SETTING=unchanged\n', { mode: 0o600 });
    symlinkSync(sample, join(s.control, 'uploads', 'loading.sql'));
    symlinkSync(outside, join(s.control, 'uploads', 'loading'));
    load(s, id, file);
    const r = await runOnce(s, null);
    expect(readFileSync(sample, 'utf8')).toBe('SAMPLE_SETTING=unchanged\n');
    expect(readdirSync(outside)).toEqual(['sample.env']);
    expect(copies(r.calls)).toHaveLength(1);
    expect(listed(s, 'uploads')).toContain(`${NID}-${id}.done`);
  });

  it('loads the upload of a machine with an id of the older length', async () => {
    const s = stand();
    const id = randomUUID();
    const older = '5'.repeat(32);
    mkdirSync(join(s.control, 'uploads'), { recursive: true });
    const file = join(s.control, 'uploads', `${older}-${id}.tar.gz`);
    spawnSync('cp', [packed(s, id, { 'public.tasks.csv': TASKS }), file]);
    spawnSync('rm', [join(s.control, 'uploads', `${NID}-${id}.tar.gz`)]);
    load(s, id, file, { database: 'hornhoof_upload_5555555555555555_20261111t120005' });
    const r = await runOnce(s, null);
    expect(copies(r.calls)).toHaveLength(1);
    expect(listed(s, 'uploads')).toEqual([`${older}-${id}.done`]);
  });

  it('refuses what is not the data of a table', async () => {
    type Case = { name: string; files?: Record<string, string>; more?: (dir: string) => string[]; over?: object; env?: Record<string, string>; busybox?: boolean; line: string; noDatabase?: boolean };
    const cases: Case[] = [
      { name: 'a file of statements', files: { 'public.tasks.csv': TASKS, 'x.sql': 'DROP DATABASE hornhoof;' }, line: 'The upload holds a file that is no table of the company.', noDatabase: true },
      { name: 'a file of another schema', files: { 'pg_catalog.pg_authid.csv': 'rolname\nx\n' }, line: 'The upload holds a file that is no table of the company.', noDatabase: true },
      {
        name: 'a path out of the folder',
        files: {},
        more: dir => (mkdirSync(join(dir, 'in')), writeFileSync(join(dir, 'public.tasks.csv'), TASKS), ['-C', join(dir, 'in'), '../public.tasks.csv']),
        line: 'The upload holds a file that is no table of the company.',
        noDatabase: true,
      },
      { name: 'a link', files: {}, more: dir => (symlinkSync('/etc/hosts', join(dir, 'public.tasks.csv')), ['public.tasks.csv']), line: 'The upload holds what is no file.', noDatabase: true },
      {
        name: 'two names of one file',
        files: { 'public.tasks.csv': TASKS },
        more: dir => (linkSync(join(dir, 'public.tasks.csv'), join(dir, 'net.journal.csv')), ['net.journal.csv']),
        line: 'The upload holds what is no file.',
        noDatabase: true,
      },
      {
        name: 'two names of one file, as BusyBox lists them',
        files: { 'public.tasks.csv': TASKS },
        more: dir => (linkSync(join(dir, 'public.tasks.csv'), join(dir, 'net.journal.csv')), ['net.journal.csv']),
        busybox: true,
        line: 'The upload holds what is no file.',
        noDatabase: true,
      },
      { name: 'more than it may unpack to', files: { 'public.tasks.csv': `id,title\n${'1,x\n'.repeat(4000)}` }, over: { unpackMax: 4096 }, line: 'The upload unpacks to more than it may.', noDatabase: true },
      { name: 'no packed file', files: {}, more: () => [], line: 'The upload cannot be read.', noDatabase: true },
      { name: 'a column the table has none of', files: { 'public.tasks.csv': 'id,nope\n1,2\n' }, line: 'A file of the upload names a column its table has none of.' },
      { name: 'a column that is no name', files: { 'public.tasks.csv': 'id,"title) FROM PROGRAM \'id\'; --"\n1,2\n' }, line: 'A file of the upload names a column its table has none of.' },
      { name: 'a file with no header', files: { 'public.tasks.csv': '' }, line: 'A file of the upload names a column its table has none of.' },
      { name: 'rows the table does not take', files: { 'public.tasks.csv': TASKS }, env: { STUB_COPY_IN: 'fail' }, line: 'A table of the upload could not be loaded.' },
      { name: 'a schema that does not load', files: { 'public.tasks.csv': TASKS }, env: { STUB_RESTORE: 'fail' }, line: "This server's schema could not be loaded into the database for the upload." },
      { name: 'a database of another name', files: { 'public.tasks.csv': TASKS }, over: { database: 'hornhoof' }, line: 'The request names no database of an upload.', noDatabase: true },
      { name: 'a size that is no number', files: { 'public.tasks.csv': TASKS }, over: { unpackMax: '1; rm -rf /' }, line: 'The request names no database of an upload.', noDatabase: true },
    ];
    for (const one of cases) {
      const s = stand();
      const id = randomUUID();
      const file =
        one.name === 'no packed file'
          ? (mkdirSync(join(s.control, 'uploads')), writeFileSync(join(s.control, 'uploads', `${NID}-${id}.tar.gz`), 'not packed'), join(s.control, 'uploads', `${NID}-${id}.tar.gz`))
          : packed(s, id, one.files ?? {}, one.more);
      load(s, id, file, one.over);
      const r = await runOnce(s, null, one.busybox ? { ...busyboxTar(s), ...one.env } : one.env);
      expect(listed(s, 'uploads'), one.name).toEqual([`${NID}-${id}.failed`]);
      expect(readFileSync(join(s.control, 'uploads', `${NID}-${id}.failed`), 'utf8').trim(), one.name).toBe(one.line);
      expect(r.out, one.name).toContain(`Could not load what a machine uploaded: ${one.line}`);
      expect(renamed(r.calls), one.name).toBe(false);
      expect(made(r.calls), one.name).toBe(!one.noDatabase);
      /* Nothing of a database that was started stays. */
      expect(readdirSync(s.dir).filter(name => name.startsWith('db-hornhoof_upload')), one.name).toEqual([]);
      expect(has(s, 'load.json'), one.name).toBe(false);
    }

    /* A file of a table this server has none of is said and left out, and the rest is loaded. */
    const s = stand();
    const id = randomUUID();
    load(s, id, packed(s, id, { 'public.tasks.csv': TASKS, 'public.gone.csv': 'id\n1\n' }));
    const r = await runOnce(s, null);
    expect(r.out).toContain('The upload holds a table this server has none of: public.gone.');
    expect(copies(r.calls)).toHaveLength(1);
    expect(listed(s, 'uploads')).toEqual([`${NID}-${id}.done`]);

    /* A database a stop left half loaded goes first. */
    const left = stand();
    writeFileSync(join(left.dir, 'db-hornhoof_uploading_00aa00aa00aa00aa_20261110t000000'), '0');
    load(left, id, packed(left, id, { 'public.tasks.csv': TASKS }));
    const after = await runOnce(left, null);
    const drop = after.calls.findIndex(c => c.endsWith('-c DROP DATABASE IF EXISTS hornhoof_uploading_00aa00aa00aa00aa_20261110t000000'));
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(after.calls.findIndex(c => c.includes('CREATE DATABASE'))).toBeGreaterThan(drop);
    expect(readdirSync(left.dir).filter(name => name.startsWith('db-hornhoof_upload'))).toEqual([`db-${DATABASE}`]);

    /* A request for a file of another name, or on a machine that is no company server, loads nothing. */
    const odd = stand();
    load(odd, id, '/etc/passwd');
    const dropped = await runOnce(odd, null);
    expect([made(dropped.calls), has(odd, 'load.json')]).toEqual([false, false]);
    const copy = stand(COPY_ENV);
    writeFileSync(join(copy.control, 'replica.json'), '{}');
    load(copy, id, packed(copy, id, { 'public.tasks.csv': TASKS }));
    expect(made((await runOnce(copy, null, COPY)).calls)).toBe(false);
  });

  /* A machine with everything a copy leaves behind. */
  function copyToWipe(env = COPY_ENV) {
    const s = stand(env);
    const id = randomUUID();
    writeFileSync(join(s.control, 'replica.json'), '{}');
    for (const dir of ['dumps', 'restore', 'schema', 'uploads']) {
      mkdirSync(join(s.control, dir));
      writeFileSync(join(s.control, dir, 'held'), 'rows');
    }
    for (const name of ['schema.json', 'dump.json', 'upload.json']) writeFileSync(join(s.control, name), '{}');
    mkdirSync(join(s.server, 'backups'));
    writeFileSync(join(s.server, 'backups', 'hornhoof-20261110T000000Z-u1.sql.gz'), 'rows');
    /* And what a copy of the database a restart cut short left. */
    writeFileSync(join(s.server, 'backups', 'hornhoof-20261111T000000Z-u2.sql.gz.part'), 'rows');
    writeFileSync(join(s.control, 'wipe.json'), JSON.stringify({ id }), { mode: 0o600 });
    return { s, id };
  }
  const stepOf = (s: Stand) => (JSON.parse(readFileSync(join(s.control, 'wipe.json'), 'utf8')) as { step?: string }).step;

  it('wipes the database, the dumps and the secrets', async () => {
    const { s, id } = copyToWipe();
    const r = await runOnce(s, null, COPY);
    const at = (text: string) => r.calls.findIndex(c => c.includes(text));
    /* It looks first whether a database here ever led, then stops what holds the data and removes the volume. */
    const asked = at('FROM net_local.state');
    const stop = r.calls.indexOf('docker compose rm -sf db migrate app node');
    const volume = r.calls.indexOf('docker volume rm hornhoof_pgdata');
    const up = r.calls.indexOf('docker compose up -d --no-build --remove-orphans front keeper');
    expect(asked).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(asked);
    expect(volume).toBeGreaterThan(stop);
    expect(up).toBeGreaterThan(volume);
    expect(r.calls[up + 1]).toBe('up as HORNHOOF_ROLE=worker');
    for (const name of ['dumps', 'restore', 'schema', 'uploads', 'schema.json', 'dump.json', 'upload.json', 'replica.json']) expect(has(s, name), name).toBe(false);
    expect(readdirSync(join(s.server, 'backups'))).toEqual([]);
    const env = envOf(s);
    expect(env).toMatchObject({ HORNHOOF_SECRET: '', NODE_KEY: '', RELAY_URL: '', POSTGRES_PASSWORD: '', HORNHOOF_ROLE: 'worker', COMPOSE_FILE: 'compose.yaml:compose.worker.yaml', HORNHOOF_VERSION: '0.4.0' });
    expect(env).not.toHaveProperty('COMPOSE_PROFILES');
    expect(statSync(join(s.server, '.env')).mode & 0o777).toBe(0o600);
    /* It says so last, and then replaces itself, so the next updater is a worker's. */
    const wiped = JSON.parse(readFileSync(join(s.control, 'wiped.json'), 'utf8')) as { id: string; at: string };
    expect(wiped.id).toBe(id);
    expect(Number.isNaN(Date.parse(wiped.at))).toBe(false);
    expect(modeOf(s, 'wiped.json')).toBe(0o600);
    expect(has(s, 'wipe.json')).toBe(false);
    expect(r.calls.findIndex(c => c.startsWith('docker run') && c.includes(`--entrypoint docker ${OWN_IMAGE} compose up -d --no-build updater`))).toBeGreaterThan(up);
    const all = everything(s, r);
    for (const secret of [SECRETS.HORNHOOF_SECRET, SECRETS.NODE_KEY, SECRETS.POSTGRES_PASSWORD]) expect(all.includes(secret)).toBe(false);
  });

  it('goes on with a wipe that failed', async () => {
    const { s } = copyToWipe();
    const first = await runOnce(s, null, { ...COPY, STUB_VOLUME_RM: 'fail' });
    expect(stepOf(s)).toBe('volume');
    expect(envOf(s)).toMatchObject({ HORNHOOF_SECRET: SECRETS.HORNHOOF_SECRET, HORNHOOF_ROLE: 'data' });
    expect([has(s, 'wiped.json'), has(s, 'dumps'), has(s, 'replica.json')]).toEqual([false, true, true]);
    expect(first.out).toContain("Could not wipe this machine's copy yet: could not remove the database's volume.");
    /* The next pass goes on from there, and looks and stops no second time. */
    const second = await runOnce(s, null, COPY);
    const fresh = second.calls.slice(first.calls.length);
    expect(fresh.some(c => c === 'docker compose rm -sf db migrate app node' || c.includes('FROM net_local.state'))).toBe(false);
    expect(fresh).toContain('docker volume rm hornhoof_pgdata');
    expect([has(s, 'wiped.json'), has(s, 'wipe.json'), has(s, 'dumps')]).toEqual([true, false, false]);
    expect(envOf(s)).toMatchObject({ HORNHOOF_SECRET: '', HORNHOOF_ROLE: 'worker' });

    /* A volume that is gone already counts as removed. */
    const gone = copyToWipe();
    writeFileSync(join(gone.s.dir, 'volume-gone'), '');
    const r = await runOnce(gone.s, null, COPY);
    expect(r.calls.some(c => c.startsWith('docker volume rm') || c.includes('FROM net_local.state'))).toBe(false);
    expect(has(gone.s, 'wiped.json')).toBe(true);
  });

  it('never wipes a database that led, nor a company server', async () => {
    const { s } = copyToWipe();
    const r = await runOnce(s, null, { ...COPY, STUB_LED: 'hornhoof' });
    expect(r.calls.some(c => c.includes(' rm -sf ') || c.startsWith('docker volume rm'))).toBe(false);
    expect(stepOf(s)).toBe('check');
    expect(r.out.split('\n').filter(line => line === "This machine's database once led the company, so it is not wiped.")).toHaveLength(1);
    expect([has(s, 'wiped.json'), has(s, 'dumps'), has(s, 'replica.json')]).toEqual([false, true, true]);
    expect(envOf(s)).toMatchObject({ HORNHOOF_SECRET: SECRETS.HORNHOOF_SECRET, HORNHOOF_ROLE: 'data' });

    /* One that led and then handed the server over in a planned switch wrote nothing the new leader lacks: it goes. */
    const handed = copyToWipe();
    const wiped = await runOnce(handed.s, null, { ...COPY, STUB_LED: 'hornhoof', STUB_HANDED: 'hornhoof' });
    expect(wiped.calls).toContain('docker volume rm hornhoof_pgdata');
    expect(has(handed.s, 'wiped.json')).toBe(true);

    /* A database that cannot be asked is not wiped either. */
    const silent = copyToWipe();
    const unasked = await runOnce(silent.s, null, { ...COPY, STUB_STATE_ASK: 'fail' });
    expect(unasked.calls.some(c => c.includes(' rm -sf ') || c.startsWith('docker volume rm'))).toBe(false);
    expect(stepOf(silent.s)).toBe('check');

    /* The settings of a company server name no role: a request there is dropped, and nothing is touched. */
    const server = stand();
    writeFileSync(join(server.control, 'wipe.json'), JSON.stringify({ id: randomUUID() }));
    const kept = await runOnce(server, null);
    expect(kept.calls.some(c => c.includes(' rm -sf ') || c.includes('volume'))).toBe(false);
    expect(has(server, 'wipe.json')).toBe(false);
    expect(readFileSync(join(server.server, '.env'), 'utf8')).toBe('HORNHOOF_SECRET=s\nHORNHOOF_VERSION=0.4.0\n');
  });
});
