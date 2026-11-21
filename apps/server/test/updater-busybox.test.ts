import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { appletsOf, HOSTILE_UPLOADS, JOURNAL, runUpdaterStep, stand, tarOf, TASKS, type Member, type Stand } from './updater-fixture.js';

/* The updater's image runs it with the commands of BusyBox 1.37 (busybox-static 1.37.0 of Alpine 3.21, which the image is
   made from), whose tar, rm and find differ from those of this machine in what matters here. HH_BUSYBOX names such a
   binary. Without one these tests do not run, and their name says so. */
const BUSYBOX = process.env.HH_BUSYBOX ?? '';
/* Every command the updater's steps here use that the image takes from BusyBox; bash, jq and the stubs stay. */
const APPLETS = ['awk', 'basename', 'cat', 'chmod', 'cut', 'dd', 'dirname', 'env', 'find', 'grep', 'gunzip', 'gzip', 'head', 'ln', 'ls', 'mkdir', 'mktemp', 'mv', 'od', 'pwd', 'rm', 'rmdir', 'sed', 'sort', 'stat', 'tail', 'tar', 'touch', 'tr', 'uniq', 'wc'];
/* Files enough that a delete takes a while, as a racing link needs a moment to be swapped in. */
const MANY = 3000;

/* The commands of BusyBox, with its tar writing down how it was called, so a test sees whether it unpacked anything. */
function busybox(s: Stand) {
  const applets = appletsOf(s, BUSYBOX, APPLETS.filter(name => name !== 'tar'));
  const log = join(s.dir, 'tar.log');
  writeFileSync(join(applets.dir, 'tar'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${BUSYBOX}' tar "$@"\n`, { mode: 0o755 });
  return { env: { PATH: applets.PATH }, tarCalls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []) };
}

function upload(s: Stand, members: Member[]): string {
  mkdirSync(join(s.control, 'uploads'), { recursive: true });
  const file = join(s.control, 'uploads', 'up.tar.gz');
  writeFileSync(file, gzipSync(tarOf(members)));
  return file;
}
const unpack = (s: Stand, env: Record<string, string>) =>
  runUpdaterStep(s, `if unpack_upload "$CONTROL/uploads/up.tar.gz" "$TMPDIR/unpacked" 1048576; then echo unpacked; else echo "refused: $UPLOAD_WHY"; fi`, env);

/* MANY files in a folder, as old as the sweep deletes, under the same names in each folder given. */
function filled(...dirs: string[]): void {
  const old = new Date(Date.now() - 25 * 3_600_000);
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < MANY; i += 1) {
      writeFileSync(join(dir, `f${i}`), '');
      utimesSync(join(dir, `f${i}`), old, old);
    }
  }
}
/* A process of the app that swaps the folder for a link to outside, by its path, the moment the first file the folder
   lists is gone. BusyBox find and rm go through a folder in the order it lists, so that is the first file they delete
   there. The racer watches that one name in a tight loop, so even a fast delete of the whole folder cannot finish
   before the swap; a racer that started a command per look lost that race on a fast machine. */
const RACER = `const fs = require('node:fs');
const [folder, outside, ready] = process.argv.slice(2);
const list = fs.opendirSync(folder);
const first = \`\${folder}/\${list.readSync().name}\`;
list.closeSync();
fs.writeFileSync(ready, '');
const end = Date.now() + 60000;
while (fs.existsSync(first)) if (Date.now() > end) process.exit(0);
try {
  fs.renameSync(folder, \`\${folder}.moved\`);
  fs.symlinkSync(outside, folder);
} catch {
  /* The folder went before the racer could move it, as the updater moves a folder away before it deletes in it. */
}
`;
/* A step of the updater with that racer at work. The step starts once the racer watches, and ends whether or not the
   swap ever happens. */
function racing(s: Stand, folder: string, outside: string, step: string): string {
  const racer = join(s.dir, 'racer.cjs');
  const ready = join(s.dir, 'racer.ready');
  writeFileSync(racer, RACER);
  return `
  '${process.execPath}' '${racer}' '${folder}' '${outside}' '${ready}' &
  racer=$!
  waited=0
  until [ -e '${ready}' ] || [ "$waited" -ge 1000 ]; do /bin/sleep 0.01; waited=$((waited + 1)); done
  status=0
  ${step} || status=$?
  kill "$racer" 2> /dev/null || true
  wait "$racer" 2> /dev/null || true
  exit "$status"
`;
}
/* How many files the tree's own folder still holds, wherever the racer left it. */
const leftIn = (folder: string) =>
  [folder, `${folder}.moved`].filter(dir => existsSync(dir) && !lstatSync(dir).isSymbolicLink()).reduce((sum, dir) => sum + readdirSync(dir).length, 0);

const tests = BUSYBOX ? describe : describe.skip;
tests(BUSYBOX ? `the updater with the commands of BusyBox 1.37 (${BUSYBOX})` : 'the updater with the commands of BusyBox 1.37: not run, as HH_BUSYBOX names no BusyBox binary', () => {
  it('runs the BusyBox the image has', () => {
    expect(spawnSync(BUSYBOX, [], { encoding: 'utf8' }).stdout.split('\n')[0]).toMatch(/^BusyBox v1\.37\.0 /);
  });

  /* What the check stands between: BusyBox tar makes a second name of a file outside the folder it unpacks in. */
  it('is a tar that makes a second name of a file outside the folder', () => {
    const s = stand();
    const outside = join(s.dir, 'outside.csv');
    writeFileSync(outside, JOURNAL, { mode: 0o600 });
    const file = join(s.dir, 'linked.tar');
    writeFileSync(file, tarOf([{ name: 'public.tasks.csv', data: TASKS }, { name: 'net.journal.csv', type: '1', link: outside }]));
    mkdirSync(join(s.dir, 'out'));
    spawnSync(BUSYBOX, ['tar', '-xf', file, '-C', join(s.dir, 'out')]);
    expect(statSync(outside).nlink).toBe(2);
  });

  it('unpacks an upload of plain files of tables', async () => {
    const s = stand();
    upload(s, [{ name: 'public.tasks.csv', data: TASKS }, { name: 'net.journal.csv', data: JOURNAL }]);
    const r = await unpack(s, busybox(s).env);
    expect(r.out.trim(), r.out).toBe('unpacked');
    expect(readdirSync(join(s.dir, 'unpacked')).sort()).toEqual(['net.journal.csv', 'public.tasks.csv']);
    expect(readFileSync(join(s.dir, 'unpacked', 'public.tasks.csv'), 'utf8')).toBe(TASKS);
  });

  it.each(HOSTILE_UPLOADS)('unpacks nothing of an upload that holds $what', async ({ members, line }) => {
    const s = stand();
    const outside = join(s.dir, 'outside.csv');
    writeFileSync(outside, JOURNAL, { mode: 0o600 });
    upload(s, [{ name: 'public.tasks.csv', data: TASKS }, ...members(outside)]);
    const tools = busybox(s);
    const r = await unpack(s, tools.env);
    expect(r.out.trim(), r.out).toBe(`refused: ${line}`);
    expect(tools.tarCalls().filter(call => /^-\w*x/.test(call))).toEqual([]);
    expect(readdirSync(join(s.dir, 'unpacked'))).toEqual([]);
    expect([readFileSync(outside, 'utf8'), statSync(outside).nlink]).toEqual([JOURNAL, 1]);
  });

  /* BusyBox find and rm, with a folder of dumps swapped for a link to outside while the old dumps go. */
  it('sweeps dumps without deleting through a folder swapped for a link meanwhile', async () => {
    const s = stand();
    const outside = join(s.dir, 'outside');
    const sub = join(s.control, 'dumps', 'sub');
    filled(sub, outside);
    const r = await runUpdaterStep(s, racing(s, sub, outside, 'sweep_dumps'), busybox(s).env);
    expect(r.code, r.out).toBe(0);
    expect(readdirSync(outside).length).toBe(MANY);
  });

  /* BusyBox rm, with a folder of dumps swapped for a link to outside while the wipe deletes. */
  it('wipes the shared folders without deleting through a folder swapped for a link meanwhile', async () => {
    const s = stand();
    const outside = join(s.dir, 'outside');
    const sub = join(s.control, 'dumps', 'sub');
    filled(sub, outside);
    const r = await runUpdaterStep(s, racing(s, sub, outside, 'wipe_step files'), busybox(s).env);
    if (r.code === 1) {
      const retry = await runUpdaterStep(s, 'wipe_step files', busybox(s).env);
      expect(retry.code, retry.out).toBe(0);
    } else {
      expect(r.code, r.out).toBe(0);
    }
    expect(readdirSync(outside).length).toBe(MANY);
    expect(existsSync(join(s.control, 'dumps'))).toBe(false);
  });

  /* What empties a folder, with a folder in it swapped for a link to outside, by its path, while it deletes in there. */
  it('empties a folder without deleting through a folder in it swapped for a link meanwhile', async () => {
    const s = stand();
    const outside = join(s.dir, 'outside');
    const tree = join(s.dir, 'tree');
    filled(join(tree, 'sub'), outside);
    const r = await runUpdaterStep(s, racing(s, join(tree, 'sub'), outside, `(cd -P -- '${tree}' && clear_here)`), busybox(s).env);
    expect(r.code, r.out).toBe(existsSync(join(tree, 'sub.moved')) ? 1 : 0);
    expect(readdirSync(outside).length).toBe(MANY);
    expect(leftIn(join(tree, 'sub'))).toBe(0);
  });

  /* BusyBox ln -T: atomic no-replace publication in once mode never overwrites a concurrent entry or descends into a directory. */
  it('publishes once with BusyBox ln -T without replacing a concurrent file, link, pipe or folder', async () => {
    const s = stand();
    const tools = busybox(s);
    const ok = await runUpdaterStep(s, 'publish "$CONTROL/clean.once" once printf "whole\\n"', tools.env);
    expect(ok.code, ok.out).toBe(0);
    expect(readFileSync(join(s.control, 'clean.once'), 'utf8')).toBe('whole\n');
    expect(statSync(join(s.control, 'clean.once')).nlink).toBe(1);

    for (const [name, plant] of [
      ['file.once', 'printf "earlier\\n" > "$last"'],
      ['link.once', `'${BUSYBOX}' ln -s /nonexistent "$last"`],
      ['pipe.once', 'PATH=/usr/bin:/bin mkfifo "$last"'],
      ['dir.once', `'${BUSYBOX}' mkdir "$last"`],
    ] as const) {
      const shims = join(s.dir, `shims-${name}`);
      mkdirSync(shims);
      for (const cmd of ['ln', 'mv'] as const) {
        writeFileSync(
          join(shims, cmd),
          `#!/bin/sh\nlast=\nfor a in "$@"; do last=$a; done\ncase "$last" in */${name}) ${plant} ;; esac\nexec '${BUSYBOX}' ${cmd} "$@"\n`,
          { mode: 0o755 },
        );
      }
      const r = await runUpdaterStep(
        s,
        `if publish "$CONTROL/${name}" once printf "later\\n"; then echo published; else echo refused; fi`,
        { PATH: `${shims}:${tools.env.PATH}` },
      );
      expect(r.code, r.out).toBe(0);
      expect(r.out.trim()).toBe('refused');
    }
    expect(readFileSync(join(s.control, 'file.once'), 'utf8')).toBe('earlier\n');
    expect(lstatSync(join(s.control, 'link.once')).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(s.control, 'pipe.once')).isFIFO()).toBe(true);
    expect(lstatSync(join(s.control, 'dir.once')).isDirectory()).toBe(true);
    expect(readdirSync(join(s.control, 'dir.once'))).toEqual([]);
    expect(readdirSync(s.control).sort()).toEqual(['clean.once', 'dir.once', 'file.once', 'link.once', 'pipe.once']);
  });
});
