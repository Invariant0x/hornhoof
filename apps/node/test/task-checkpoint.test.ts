import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_EXPORT_FILES, captureTaskCheckpoint } from '../src/task-checkpoint.js';
import { accepted, closure, git, gitInput, id, makeStand, TASK_ID, wipFile, wipManifest, wipPaths, WIP_REF, type Stand } from './handoff-stand.js';

let stand: Stand;
beforeEach(() => { stand = makeStand(); });
afterEach(() => { stand.close(); });

const fileOf = (path: string) => wipManifest(stand.remote).files.find(file => file.path === path);
const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
const everything = () => closure(stand.remote).map(object => object.body).join('\n');

/* Every kind of change at once, and one secret line only in a commit the source already took back. */
function dirtyWorkspace(): void {
  stand.write('src/unpublished.ts', ['export const left', 'Behind = 1;\n'].join(''));
  stand.commit('Unpublished, then taken back');
  rmSync(join(stand.source, 'src/unpublished.ts'));
  stand.write('src/committed.ts', 'export const committed = 1;\n');
  stand.commit('Second unpublished commit');
  stand.write('src/staged.ts', 'export const staged = 1;\n');
  git(stand.source, 'add', 'src/staged.ts');
  stand.write('src/changed.ts', 'export const changed = 2;\n');
  rmSync(join(stand.source, 'src/gone.ts'));
  git(stand.source, 'mv', 'src/moved.ts', 'src/renamed.ts');
  stand.write('src/untracked.ts', 'export const untracked = 1;\n');
  stand.write('run.sh', '#!/bin/sh\nexit 0\n');
  chmodSync(join(stand.source, 'run.sh'), 0o755);
}

describe('what a checkpoint holds', () => {
  it('is one orphan commit of fixed paths with the whole change against the base', async () => {
    dirtyWorkspace();
    const headBefore = git(stand.source, 'rev-parse', 'HEAD');
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));

    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(receipt.checkpointSha);
    expect(git(stand.remote, 'rev-list', '--parents', WIP_REF)).toBe(receipt.checkpointSha);
    const manifest = wipManifest(stand.remote);
    expect(manifest).toMatchObject({ version: 1, handoffId: id(10), captureId: id(11), captureSequence: 1, taskId: TASK_ID, taskNumber: 434, epoch: 3,
      baseSha: stand.baseSha, sourceHeadSha: headBefore, previousCheckpointSha: null, requiresRepair: false,
      context: { diffStat: 'present', lastTests: 'present', conversationTail: 'present' } });
    const actions = Object.fromEntries(manifest.files.map(file => [file.path, file.action]));
    expect(actions).toEqual({ 'run.sh': 'add', 'src/changed.ts': 'replace', 'src/committed.ts': 'add', 'src/gone.ts': 'delete',
      'src/moved.ts': 'delete', 'src/renamed.ts': 'add', 'src/staged.ts': 'add', 'src/untracked.ts': 'add' });

    const payloads = manifest.files.filter(file => file.action !== 'delete').map(file => `files/${file.id}`);
    expect(wipPaths(stand.remote).sort()).toEqual(['meta/conversation-tail.txt', 'meta/diff-stat.txt', 'meta/last-tests.txt', 'meta/manifest.json', ...payloads].sort());
    expect(manifest.files.map(file => file.id)).toEqual(manifest.files.map((_, index) => String(index + 1).padStart(6, '0')));
    const changed = fileOf('src/changed.ts')!;
    expect(wipFile(stand.remote, `files/${changed.id}`)).toBe('export const changed = 2;');
    expect(changed).toMatchObject({ status: 'clean', mode: '100644', contentSha256: sha256('export const changed = 2;\n') });
    expect(fileOf('run.sh')).toMatchObject({ mode: '100755' });
    expect(fileOf('src/gone.ts')).toMatchObject({ mode: null, contentSha256: null, status: 'clean' });
    expect(receipt).toEqual({ handoffId: id(10), captureId: id(11), baseSha: stand.baseSha, checkpointSha: receipt.checkpointSha, sanitizerVersion: manifest.sanitizerVersion,
      contentDigest: sha256(wipFile(stand.remote, 'meta/manifest.json')), redactedFiles: 0, omittedFiles: 0, requiresRepair: false, quiescent: true });
  });

  it('keeps every payload entry a plain file and the fixed identity on the commit', async () => {
    dirtyWorkspace();
    accepted(await captureTaskCheckpoint(stand.input()));
    const modes = git(stand.remote, 'ls-tree', '-r', WIP_REF).split('\n').map(line => line.split(' ')[0]);
    expect(new Set(modes)).toEqual(new Set(['100644']));
    const commit = git(stand.remote, 'cat-file', 'commit', WIP_REF);
    expect(commit).toMatch(/^tree [0-9a-f]{40}\nauthor Hornhoof <checkpoint@hornhoof\.invalid> 1 \+0000\ncommitter Hornhoof <checkpoint@hornhoof\.invalid> 1 \+0000\n\nTask checkpoint 00000000-0000-4000-8000-000000000011$/);
  });

  it('carries no project history: no base, no source commit, no blob of a commit taken back', async () => {
    dirtyWorkspace();
    accepted(await captureTaskCheckpoint(stand.input()));
    const objects = closure(stand.remote), shas = objects.map(object => object.sha);
    expect(shas).not.toContain(stand.baseSha);
    expect(shas).not.toContain(git(stand.source, 'rev-parse', 'HEAD'));
    expect(objects.filter(object => object.type === 'commit')).toHaveLength(1);
    const body = objects.map(object => object.body).join('\n');
    expect(body).not.toContain(['left', 'Behind'].join(''));
    expect(body).not.toContain('Second unpublished commit');
    expect(body).not.toContain('export const keep');
    expect(body).not.toContain('test@example.invalid');
  });

  it('counts the three context parts in fixed files and says when one is unavailable', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    stand.write('.env', 'not read at all\n');
    accepted(await captureTaskCheckpoint(stand.input({ lastTests: null, conversationTail: 'line one\nline two\n' })));
    expect(wipManifest(stand.remote).context).toEqual({ diffStat: 'present', lastTests: 'unavailable', conversationTail: 'present' });
    expect(wipFile(stand.remote, 'meta/last-tests.txt')).toBe('unavailable');
    expect(wipFile(stand.remote, 'meta/conversation-tail.txt')).toBe('line one\nline two');
    const stat = wipFile(stand.remote, 'meta/diff-stat.txt');
    expect(stat).toContain('replace clean 26 src/changed.ts');
    expect(stat).toContain('files 1: clean 1, redacted 0, omitted 0; left out as not task work 1');
    expect(stat).not.toContain('.env');
  });

  it('reads a linked worktree through its own index without going near its shared settings', async () => {
    const tree = join(stand.root, 'linked');
    git(stand.source, 'worktree', 'add', '--quiet', '-b', 'task-2', tree, stand.baseSha);
    writeFileSync(join(tree, 'src/changed.ts'), 'export const changed = 3;\n');
    git(tree, 'add', 'src/changed.ts');
    const workspace = { ...stand.workspace(), realPath: tree, sourceHeadSha: git(tree, 'rev-parse', 'HEAD'),
      gitCommonDir: git(tree, 'rev-parse', '--path-format=absolute', '--git-common-dir') };
    accepted(await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => workspace })));
    expect(wipManifest(stand.remote).files.map(file => file.path)).toEqual(['src/changed.ts']);
  });
});

describe('the source workspace', () => {
  it('stays exactly as it was: HEAD, branch, index, status, stash and settings', async () => {
    dirtyWorkspace();
    const look = () => ({
      head: git(stand.source, 'rev-parse', 'HEAD'), branch: git(stand.source, 'symbolic-ref', 'HEAD'),
      index: sha256(readFileSync(join(stand.source, '.git/index'))), config: sha256(readFileSync(join(stand.source, '.git/config'))),
      stash: git(stand.source, 'stash', 'list'), refs: git(stand.source, 'for-each-ref'),
    });
    const before = look(), status = git(stand.source, 'status', '--porcelain=v2', '-z');
    accepted(await captureTaskCheckpoint(stand.input()));
    expect(look()).toEqual({ ...before, index: look().index });
    expect(git(stand.source, 'status', '--porcelain=v2', '-z')).toBe(status);
    expect(git(stand.remote, 'rev-parse', 'refs/heads/main')).toBe(stand.baseSha);
    expect(() => git(stand.remote, 'rev-parse', '--verify', 'refs/heads/task-1')).toThrow();
  });

  it('runs nothing the repository configured: filters, monitors, hooks, diff programs, included settings', async () => {
    const mark = join(stand.root, 'ran'), program = join(stand.root, 'program.sh');
    writeFileSync(program, `#!/bin/sh\ntouch '${mark}'\ncat\n`);
    chmodSync(program, 0o755);
    const included = join(stand.root, 'included.cfg');
    writeFileSync(included, `[filter "evil"]\n\tclean = ${program}\n\tsmudge = ${program}\n`);
    git(stand.source, 'config', 'filter.evil.clean', program);
    git(stand.source, 'config', 'filter.evil.process', program);
    git(stand.source, 'config', 'filter.evil.required', 'true');
    git(stand.source, 'config', 'core.fsmonitor', program);
    git(stand.source, 'config', 'diff.external', program);
    git(stand.source, 'config', 'diff.evil.textconv', program);
    git(stand.source, 'config', 'core.sshCommand', program);
    git(stand.source, 'config', 'include.path', included);
    git(stand.source, 'config', 'core.hooksPath', join(stand.root, 'hooks'));
    mkdirSync(join(stand.root, 'hooks'));
    for (const hook of ['post-index-change', 'pre-push', 'reference-transaction']) { writeFileSync(join(stand.root, 'hooks', hook), `#!/bin/sh\ntouch '${mark}'\n`); chmodSync(join(stand.root, 'hooks', hook), 0o755); }
    writeFileSync(join(stand.source, '.gitattributes'), '* filter=evil diff=evil\n');
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    accepted(await captureTaskCheckpoint(stand.input()));
    expect(existsSync(mark)).toBe(false);
    expect(fileOf('src/changed.ts')?.status).toBe('clean');
  });

  it('sees a change the index was told to hide, and marks it instead of losing it', async () => {
    for (const flag of ['--skip-worktree', '--assume-unchanged']) {
      git(stand.source, 'update-index', flag, flag === '--skip-worktree' ? 'src/changed.ts' : 'src/keep.ts');
    }
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    stand.write('src/keep.ts', 'export const keep = 2;\n');
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(receipt.requiresRepair).toBe(true);
    expect(fileOf('src/changed.ts')).toMatchObject({ status: 'omitted', contentSha256: null });
    expect(fileOf('src/keep.ts')).toMatchObject({ status: 'omitted', contentSha256: null });
  });

  it('sees an edit of the same size made in the second the index was written', async () => {
    /* Git trusts such an entry only while the index looks older than the file. A copy of the index must not look newer. */
    const second = (name: string) => Math.floor(statSync(join(stand.source, name)).mtimeMs / 1000);
    for (let at = 0; at !== second('src/changed.ts') || at !== second('.git/index');) {
      stand.write('src/changed.ts', 'export const changed = 1;\n');
      git(stand.source, 'add', 'src/changed.ts');
      at = second('src/changed.ts');
      stand.write('src/changed.ts', 'export const changed = 2;\n');
    }
    await new Promise(resolve => setTimeout(resolve, 1100));
    accepted(await captureTaskCheckpoint(stand.input()));
    expect(wipFile(stand.remote, `files/${fileOf('src/changed.ts')!.id}`)).toBe('export const changed = 2;');
  });

  it('notices a file that moved during the capture and publishes nothing', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    let calls = 0;
    const result = await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => {
      if (++calls === 2) stand.write('src/changed.ts', 'export const changed = 3;\n');
      return stand.workspace();
    } }));
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'source_not_quiescent', retryable: true } });
    expect(() => git(stand.remote, 'rev-parse', '--verify', WIP_REF)).toThrow();
  });

  it('notices a new file and a new commit during the capture', async () => {
    let calls = 0;
    const newFile = await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => {
      if (++calls === 2) stand.write('src/late.ts', 'export const late = 1;\n');
      return stand.workspace();
    } }));
    expect(newFile).toMatchObject({ ok: false, problem: { code: 'source_not_quiescent' } });
    calls = 0;
    const newCommit = await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => {
      if (++calls === 2) stand.commit('A commit during the capture');
      return stand.workspace();
    } }));
    expect(newCommit).toMatchObject({ ok: false, problem: { code: 'source_not_quiescent' } });
  });
});

describe('secrets do not leave', () => {
  const SECRET_FORMS = (secret: string) => [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex')];

  it('takes a known short secret and its encodings out of code, path, tests and tail, in every object', async () => {
    const secret = ['q', 'z', '7', 'x'].join('');
    stand.write('src/changed.ts', `export const changed = 2;\nconst note = "${secret}";\nconst more = "${Buffer.from(secret).toString('base64')}";\nexport const after = 1;\n`);
    stand.write(`src/${secret}/name.ts`, 'export const named = 1;\n');
    const receipt = accepted(await captureTaskCheckpoint(stand.input({ secrets: [secret],
      lastTests: `ok\nthe run used ${secret} here\nok again\n`, conversationTail: `said ${secret}\nsaid nothing\n` })));
    const body = everything();
    for (const form of SECRET_FORMS(secret)) expect(body).not.toContain(form);
    expect(receipt).toMatchObject({ requiresRepair: true, redactedFiles: 1, omittedFiles: 1 });
    expect(wipFile(stand.remote, `files/${fileOf('src/changed.ts')!.id}`)).toBe('export const changed = 2;\n[redacted]\n[redacted]\nexport const after = 1;');
    expect(fileOf('src/changed.ts')?.status).toBe('redacted');
    expect(fileOf('[redacted]')).toMatchObject({ status: 'omitted', contentSha256: null, mode: null });
    expect(wipFile(stand.remote, 'meta/last-tests.txt')).toBe('ok\n[redacted]\nok again');
    expect(wipFile(stand.remote, 'meta/conversation-tail.txt')).toBe('[redacted]\nsaid nothing');
  });

  it('joins the repository token to the secrets it was told about', async () => {
    const token = ['tok', 'en', 'value', '9'].join('-');
    stand.write('src/changed.ts', `const seen = "${token}";\n`);
    const receipt = accepted(await captureTaskCheckpoint(stand.input({ repo: { url: `file://${stand.remote}`, token } })));
    expect(receipt.requiresRepair).toBe(true);
    expect(everything()).not.toContain(token);
  });

  it('does not let metadata alone stop a clean handover', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const fake = ['gh', 'p_', 'A'.repeat(36)].join('');
    const receipt = accepted(await captureTaskCheckpoint(stand.input({ lastTests: `token ${fake}\n`, conversationTail: `Authorization: Bearer ${['abc', 'def', '0123456789'].join('')}\n` })));
    expect(receipt).toMatchObject({ requiresRepair: false, redactedFiles: 0 });
    expect(everything()).not.toContain(fake);
    expect(wipFile(stand.remote, 'meta/conversation-tail.txt')).toBe('[redacted]');
  });

  it('never publishes a file on a credential path, tracked or not, and asks for repair only when it was tracked', async () => {
    const value = ['value', 'of', 'dot', 'env'].join('-');
    stand.write('.env', `PLAIN=${value}\n`);
    stand.write('config/credentials.json', `{"plain":"${value}"}\n`);
    let receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(receipt.requiresRepair).toBe(false);
    expect(everything()).not.toContain(value);
    expect(wipPaths(stand.remote).filter(path => path.startsWith('files/'))).toEqual([]);
    expect(wipFile(stand.remote, 'meta/diff-stat.txt')).toContain('left out as not task work 2');

    git(stand.source, 'add', '-f', '.env');
    receipt = accepted(await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2 })));
    expect(receipt).toMatchObject({ requiresRepair: true, omittedFiles: 1 });
    expect(fileOf('.env')).toMatchObject({ status: 'omitted', contentSha256: null, mode: null });
    expect(everything()).not.toContain(value);
  });

  it('leaves out generated output, even tracked, and a declared output in such a place refuses the capture', async () => {
    const generated = ['generated', 'bundle', 'text'].join('-');
    stand.write('dist/app.js', `${generated}\n`);
    stand.write('node_modules/lib/index.js', `${generated}\n`);
    expect(accepted(await captureTaskCheckpoint(stand.input())).requiresRepair).toBe(false);
    expect(everything()).not.toContain(generated);

    const refused = await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2, declaredOutputs: ['dist/app.js'] }));
    expect(refused).toEqual({ ok: false, problem: { phase: 'capture', code: 'unsupported_required_output', retryable: false } });

    git(stand.source, 'add', '-f', 'dist/app.js');
    const tracked = accepted(await captureTaskCheckpoint(stand.input({ captureId: id(13), captureSequence: 3 })));
    expect(tracked.requiresRepair).toBe(true);
    expect(fileOf('dist/app.js')?.status).toBe('omitted');
  });

  it('finds a declared output Git ignores, under the same cleaning', async () => {
    writeFileSync(join(stand.source, '.gitignore'), 'report.txt\n');
    stand.write('report.txt', 'a report the task owes\n');
    accepted(await captureTaskCheckpoint(stand.input({ declaredOutputs: ['report.txt'] })));
    expect(fileOf('report.txt')).toMatchObject({ status: 'clean', action: 'add' });
    expect(wipFile(stand.remote, `files/${fileOf('report.txt')!.id}`)).toBe('a report the task owes');
  });

  it('withholds what cannot be read as safe text and marks it for repair', async () => {
    const outside = join(stand.root, 'outside.txt'), marker = ['outside', 'words'].join('-');
    writeFileSync(outside, `${marker}\n`);
    stand.write('bin/blob.bin', Buffer.from([0, 1, 2, 3, 255, 254]));
    stand.write('bad/latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    stand.write('big/large.txt', Buffer.alloc(1024 * 1024 + 1, 'a'));
    stand.write('lfs/pointer.bin', 'version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1\n');
    mkdirSync(join(stand.source, 'links'));
    symlinkSync(outside, join(stand.source, 'links/external'));
    symlinkSync('../src/keep.ts', join(stand.source, 'links/internal'));
    symlinkSync(join(stand.root), join(stand.source, 'links/folder'));
    linkSync(outside, join(stand.source, 'links/hard'));
    execFileSync('/usr/bin/mkfifo', [join(stand.source, 'links/pipe')]);
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(receipt.requiresRepair).toBe(true);
    const statuses = Object.fromEntries(wipManifest(stand.remote).files.map(file => [file.path, file.status]));
    for (const path of ['bin/blob.bin', 'bad/latin.txt', 'big/large.txt', 'lfs/pointer.bin', 'links/external', 'links/internal', 'links/folder', 'links/hard']) expect(statuses[path]).toBe('omitted');
    expect(wipManifest(stand.remote).files.filter(file => file.status !== 'omitted')).toEqual([]);
    expect(everything()).not.toContain(marker);
    expect(wipPaths(stand.remote).filter(path => path.startsWith('files/'))).toEqual([]);
  });

  it('withholds a file whose name is no valid text, and does not spell the name', async () => {
    const name = Buffer.concat([Buffer.from(join(stand.source, 'src/caf')), Buffer.from([0xe9]), Buffer.from('.ts')]);
    writeFileSync(name, 'export const named = 1;\n');
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(receipt).toMatchObject({ requiresRepair: true, omittedFiles: 1 });
    expect(wipManifest(stand.remote).files.map(file => [file.path, file.status])).toEqual([['[redacted]', 'omitted']]);
    expect(everything()).not.toContain('caf');
    expect(everything()).not.toContain('export const named');
  });

  it('withholds a submodule and a nested repository', async () => {
    const nested = join(stand.source, 'nested');
    git(stand.root, 'init', '--quiet', nested);
    writeFileSync(join(nested, 'inner.txt'), 'inner\n');
    git(nested, 'add', '-A');
    git(nested, 'commit', '--quiet', '-m', 'Inner');
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(receipt.requiresRepair).toBe(true);
    expect(wipManifest(stand.remote).files.map(file => [file.path, file.status])).toEqual([['nested', 'omitted']]);
    git(stand.source, 'add', 'nested');
    const gitlink = accepted(await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2 })));
    expect(gitlink.requiresRepair).toBe(true);
    expect(fileOf('nested')).toMatchObject({ status: 'omitted' });
  });

  describe('a submodule', () => {
    function submodule(): { nested: string; mark: string; program: string } {
      const nested = join(stand.source, 'nested'), mark = join(stand.root, 'ran'), program = join(stand.root, 'program.sh');
      writeFileSync(program, `#!/bin/sh\ntouch '${mark}'\ncat\n`);
      chmodSync(program, 0o755);
      git(stand.root, 'init', '--quiet', nested);
      writeFileSync(join(nested, 'inner.txt'), 'inner\n');
      writeFileSync(join(nested, '.gitattributes'), '* filter=evil\n');
      git(nested, 'add', '-A');
      git(nested, 'commit', '--quiet', '-m', 'Inner');
      git(stand.source, 'add', 'nested');
      return { nested, mark, program };
    }
    it('is not entered: its settings run nothing, and work that may lie in it is marked', async () => {
      const { nested, mark, program } = submodule();
      const base = stand.commit('A submodule');
      git(nested, 'config', 'filter.evil.clean', program);
      git(nested, 'config', 'core.fsmonitor', program);
      writeFileSync(join(nested, 'inner.txt'), 'inner work\n');
      const receipt = accepted(await captureTaskCheckpoint(stand.input({ baseSha: base })));
      expect(existsSync(mark)).toBe(false);
      expect(receipt.requiresRepair).toBe(true);
      expect(fileOf('nested')).toMatchObject({ status: 'omitted' });
      expect(everything()).not.toContain('inner work');
    });
    it('that nobody checked out holds no work and stops nothing', async () => {
      const { nested } = submodule();
      const base = stand.commit('A submodule');
      rmSync(nested, { recursive: true });
      mkdirSync(nested);
      stand.write('src/changed.ts', 'export const changed = 2;\n');
      const receipt = accepted(await captureTaskCheckpoint(stand.input({ baseSha: base })));
      expect(receipt.requiresRepair).toBe(false);
      expect(wipManifest(stand.remote).files.map(file => file.path)).toEqual(['src/changed.ts']);
    });
  });

  it('keeps secrets out of the private journal too', async () => {
    const secret = ['journal', 'secret', 'value'].join('-');
    stand.write('src/changed.ts', `const seen = "${secret}";\n`);
    accepted(await captureTaskCheckpoint(stand.input({ secrets: [secret] })));
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]);
    for (const file of walk(stand.journal)) expect(readFileSync(file).includes(secret)).toBe(false);
    const db = join(stand.journal, 'handoffs', id(10), id(11), 'export.git');
    for (const line of git(db, 'cat-file', '--batch-all-objects', '--batch-check').split('\n')) {
      expect(git(db, 'cat-file', '-p', line.slice(0, 40))).not.toContain(secret);
    }
    for (const folder of [stand.journal, join(stand.journal, 'handoffs'), join(stand.journal, 'handoffs', id(10)), join(stand.journal, 'handoffs', id(10), id(11))]) expect(statSync(folder).mode & 0o077).toBe(0);
  });

  it('refuses a journal others can read, and says so without words of its own', async () => {
    mkdirSync(stand.journal, { mode: 0o755 });
    chmodSync(stand.journal, 0o755);
    const result = await captureTaskCheckpoint(stand.input());
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'scan_failed', retryable: false } });
  });

  it('refuses more bytes than it may export before it writes one object', async () => {
    const mebibyte = `${'a'.repeat(1023)}\n`.repeat(1024);
    for (let n = 0; n <= 64; n++) stand.write(`large/${n}.txt`, mebibyte);
    const result = await captureTaskCheckpoint(stand.input());
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'export_too_large', retryable: false } });
    expect(() => git(stand.remote, 'rev-parse', '--verify', WIP_REF)).toThrow();
  }, 60_000);

  it('refuses too many files before it writes one object', async () => {
    for (let n = 0; n <= MAX_EXPORT_FILES; n++) stand.write(`many/${n}.txt`, 'x\n');
    const result = await captureTaskCheckpoint(stand.input());
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'export_too_large', retryable: false } });
    expect(() => git(stand.remote, 'rev-parse', '--verify', WIP_REF)).toThrow();
  });
});

describe('a capture repeated', () => {
  it('returns the sealed commit for the same capture without reading the workspace again', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const first = accepted(await captureTaskCheckpoint(stand.input()));
    stand.write('src/changed.ts', 'export const changed = 3;\n');
    const again = accepted(await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => { throw new Error('read again'); } })));
    expect(again).toEqual(first);
    expect(git(stand.remote, 'rev-list', '--count', WIP_REF)).toBe('1');
  });

  it('says a remote it cannot reach may be tried again, and then saves', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const moved = `${stand.remote}.away`;
    execFileSync('/bin/mv', [stand.remote, moved]);
    const lost = await captureTaskCheckpoint(stand.input());
    expect(lost).toEqual({ ok: false, problem: { phase: 'capture', code: 'network_unavailable', retryable: true } });
    execFileSync('/bin/mv', [moved, stand.remote]);
    const first = accepted(await captureTaskCheckpoint(stand.input()));
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(first.checkpointSha);
  });

  it('retries the push of a sealed commit and does not build another', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const hook = join(stand.remote, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    const refused = await captureTaskCheckpoint(stand.input());
    expect(refused).toEqual({ ok: false, problem: { phase: 'publish', code: 'ref_conflict', retryable: false } });
    rmSync(hook);
    stand.write('src/changed.ts', 'export const changed = 3;\n');
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(wipFile(stand.remote, `files/${wipManifest(stand.remote).files[0]!.id}`)).toBe('export const changed = 2;');
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(receipt.checkpointSha);
  });

  it('chains a later capture on the verified previous checkpoint alone, by fast-forward', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const first = accepted(await captureTaskCheckpoint(stand.input()));
    stand.write('src/changed.ts', 'export const changed = 3;\n');
    stand.commit('More work');
    const second = accepted(await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2 })));
    expect(second.checkpointSha).not.toBe(first.checkpointSha);
    expect(git(stand.remote, 'rev-list', '--parents', WIP_REF).split('\n')[0]).toBe(`${second.checkpointSha} ${first.checkpointSha}`);
    expect(wipManifest(stand.remote).previousCheckpointSha).toBe(first.checkpointSha);
    expect(closure(stand.remote).filter(object => object.type === 'commit').map(object => object.sha).sort()).toEqual([first.checkpointSha, second.checkpointSha].sort());
  });

  it('two captures at once wait for each other and end in one commit', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const [one, two] = await Promise.all([captureTaskCheckpoint(stand.input()), captureTaskCheckpoint(stand.input())]);
    expect(accepted(one)).toEqual(accepted(two));
    expect(git(stand.remote, 'rev-list', '--count', WIP_REF)).toBe('1');
  });

  it('takes the task branch head as base when asked, and refuses a base that is not an ancestor', async () => {
    stand.write('src/first.ts', 'export const first = 1;\n');
    const pushed = stand.commit('Pushed to the task branch');
    stand.write('src/second.ts', 'export const second = 1;\n');
    accepted(await captureTaskCheckpoint(stand.input({ baseSha: pushed })));
    expect(wipManifest(stand.remote).baseSha).toBe(pushed);
    expect(wipManifest(stand.remote).files.map(file => file.path)).toEqual(['src/second.ts']);

    git(stand.source, 'checkout', '--quiet', '-b', 'elsewhere', stand.baseSha);
    stand.write('src/elsewhere.ts', 'export const elsewhere = 1;\n');
    const stranger = stand.commit('Not on the way');
    git(stand.source, 'checkout', '--quiet', 'task-1');
    const refused = await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2, baseSha: stranger }));
    expect(refused).toEqual({ ok: false, problem: { phase: 'capture', code: 'ref_conflict', retryable: false } });
  });
});

describe('the WIP ref and the work of others', () => {
  /* A commit on the WIP ref that this code did not make. */
  function plantWip(tree: Record<string, string>, parents: string[] = [], ref = WIP_REF): string {
    const blobs = Object.entries(tree).map(([name, text]) => `100644 blob ${gitInput(stand.remote, text, 'hash-object', '-w', '--stdin')}\t${name}\n`);
    const treeSha = gitInput(stand.remote, blobs.join(''), 'mktree');
    const sha = git(stand.remote, 'commit-tree', treeSha, ...parents.flatMap(parent => ['-p', parent]), '-m', 'Somebody else');
    git(stand.remote, 'update-ref', ref, sha);
    return sha;
  }

  it('refuses a WIP ref that is not a checkpoint chain, leaves it alone and never forces', async () => {
    const planted = plantWip({ 'notes.txt': 'not a checkpoint\n' });
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const result = await captureTaskCheckpoint(stand.input());
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'ref_conflict', retryable: false } });
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(planted);
  });

  it('refuses to attach a chain with a project ancestor', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const first = accepted(await captureTaskCheckpoint(stand.input()));
    const tree = git(stand.remote, 'rev-parse', `${first.checkpointSha}^{tree}`);
    const forged = git(stand.remote, 'commit-tree', tree, '-p', stand.baseSha, '-m', `Task checkpoint ${id(11)}`);
    git(stand.remote, 'update-ref', WIP_REF, forged);
    const result = await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2 }));
    expect(result).toMatchObject({ ok: false, problem: { code: 'ref_conflict' } });
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(forged);
  });

  it('refuses a previous checkpoint that now holds a known secret and reports it', async () => {
    const later = ['learned', 'later', 'value'].join('-');
    stand.write('src/changed.ts', `const seen = "${later}";\n`);
    const first = accepted(await captureTaskCheckpoint(stand.input()));
    expect(first.requiresRepair).toBe(false);
    const result = await captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2, secrets: [later] }));
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'scan_failed', retryable: false } });
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(first.checkpointSha);
  });

  it('refuses when the ref moved between sealing and pushing', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const hook = join(stand.remote, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    chmodSync(hook, 0o755);
    await captureTaskCheckpoint(stand.input());
    rmSync(hook);
    const planted = plantWip({ 'notes.txt': 'came in between\n' });
    const result = await captureTaskCheckpoint(stand.input());
    expect(result).toEqual({ ok: false, problem: { phase: 'publish', code: 'ref_conflict', retryable: false } });
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(planted);
  });

  it('reads its own ref, not one that only ends the same', async () => {
    const planted = plantWip({ 'notes.txt': 'another ref\n' }, [], `refs/aside/${WIP_REF}`);
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const receipt = accepted(await captureTaskCheckpoint(stand.input()));
    expect(receipt.checkpointSha).not.toBe(planted);
    expect(git(stand.remote, 'rev-parse', WIP_REF)).toBe(receipt.checkpointSha);
    expect(git(stand.remote, 'rev-parse', `refs/aside/${WIP_REF}`)).toBe(planted);
  });

  it('touches no other ref of the remote', async () => {
    const other = `refs/heads/wip/task-${id(999)}`, planted = plantWip({ 'notes.txt': 'another task\n' }, [], other);
    git(stand.remote, 'update-ref', 'refs/heads/task-other', stand.baseSha);
    const before = git(stand.remote, 'for-each-ref');
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    accepted(await captureTaskCheckpoint(stand.input()));
    const after = git(stand.remote, 'for-each-ref').split('\n').filter(line => !line.endsWith(WIP_REF)).join('\n');
    expect(after).toBe(before);
    expect(git(stand.remote, 'rev-parse', other)).toBe(planted);
  });
});

describe('a capture refused', () => {
  it('follows the problem of the real resolver with its own fixed code', async () => {
    const refused = async (code: 'workspace_missing' | 'binding_stale' | 'wrong_branch', retryable: boolean) =>
      captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => ({ code, retryable }) }));
    expect(await refused('workspace_missing', true)).toEqual({ ok: false, problem: { phase: 'capture', code: 'workspace_missing', retryable: true } });
    expect(await refused('binding_stale', false)).toEqual({ ok: false, problem: { phase: 'capture', code: 'stale_epoch', retryable: false } });
    expect(await refused('wrong_branch', false)).toEqual({ ok: false, problem: { phase: 'capture', code: 'workspace_ambiguous', retryable: false } });
  });

  it('refuses a workspace of another task or another owner', async () => {
    const other = { ...stand.workspace(), binding: { ...stand.workspace().binding, taskId: id(999) } };
    expect(await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => other }))).toMatchObject({ ok: false, problem: { code: 'workspace_ambiguous' } });
    const stranger = { ...stand.workspace(), ownerUid: process.getuid!() + 1 };
    expect(await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => stranger }))).toMatchObject({ ok: false, problem: { code: 'workspace_ambiguous' } });
  });

  it('carries no words of an exception, however they got there', async () => {
    const words = ['what', 'the', 'program', 'said'].join(' ');
    const result = await captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => { throw new Error(words); } }));
    expect(JSON.stringify(result)).not.toContain(words);
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'scan_failed', retryable: false } });
  });

  it('refuses an identifier that would walk out of the journal', async () => {
    const result = await captureTaskCheckpoint(stand.input({ captureId: '../../../outside' }));
    expect(result).toMatchObject({ ok: false, problem: { code: 'scan_failed' } });
    expect(existsSync(join(stand.root, 'outside'))).toBe(false);
  });

  it('stops at a cancel while another capture holds the task, and publishes nothing of its own', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const stop = new AbortController();
    let release = () => { /* Set below. */ };
    const held = new Promise<void>(resolve => { release = resolve; });
    let holding = () => { /* Set below. */ };
    const inside = new Promise<void>(resolve => { holding = resolve; });
    const first = captureTaskCheckpoint(stand.input({ resolveWorkspace: async () => { holding(); await held; return stand.workspace(); } }));
    await inside;
    const second = captureTaskCheckpoint(stand.input({ captureId: id(12), captureSequence: 2, signal: stop.signal }));
    stop.abort();
    expect(await second).toEqual({ ok: false, problem: { phase: 'capture', code: 'cancelled', retryable: false } });
    release();
    accepted(await first);
    expect(wipManifest(stand.remote).captureId).toBe(id(11));
  });

  it('stops at a cancel and publishes nothing', async () => {
    stand.write('src/changed.ts', 'export const changed = 2;\n');
    const stop = new AbortController();
    stop.abort();
    const result = await captureTaskCheckpoint(stand.input({ signal: stop.signal }));
    expect(result).toEqual({ ok: false, problem: { phase: 'capture', code: 'cancelled', retryable: false } });
    expect(() => git(stand.remote, 'rev-parse', '--verify', WIP_REF)).toThrow();
  });
});
