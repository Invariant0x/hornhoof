import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');
const folderOf = name => (name === '@hornhoof/protocol' ? 'packages/protocol' : `apps/${name.slice('@hornhoof/'.length)}`);

/* The first stage of a Dockerfile: the folders it copies whole and the workspaces it then builds. */
function buildStage(dockerfile) {
  const [, stage] = read(dockerfile).split(/^FROM /m);
  return {
    copied: [...stage.matchAll(/^COPY (\S+) \1$/gm)].map(match => match[1]),
    built: [...stage.match(/^RUN npm run build .*$/m)[0].matchAll(/-w (\S+)/g)].map(match => match[1]),
  };
}

/* What the tsc of a workspace's build reads, its dependencies aside. */
function readByBuild(folder) {
  const [, config] = /tsc -p (\S+)/.exec(JSON.parse(read(`${folder}/package.json`)).scripts.build);
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  const listed = execFileSync(tsc, ['-p', `${folder}/${config}`, '--listFilesOnly'], { cwd: ROOT, encoding: 'utf8' });
  return listed.trim().split('\n').filter(file => !file.includes('/node_modules/')).map(file => relative(ROOT, file));
}

for (const dockerfile of ['Dockerfile', 'apps/node/Dockerfile']) {
  const { copied, built } = buildStage(dockerfile);

  test(`${dockerfile} copies folders and builds workspaces`, () => {
    assert.ok(copied.length > 0 && built.length > 0, `copied ${copied}, built ${built}`);
  });

  for (const name of built) {
    /* Docker's context leaves out every test folder, see .dockerignore. */
    test(`${dockerfile} gives the build of ${name} all it reads`, () => {
      const files = readByBuild(folderOf(name));
      assert.ok(files.length > 0);
      assert.deepEqual(files.filter(file => !copied.some(folder => file.startsWith(`${folder}/`)) || /(^|\/)test\//.test(file)), []);
    });
  }
}
