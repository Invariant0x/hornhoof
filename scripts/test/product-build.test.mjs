import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readProject } from '../release/project.mjs';

const ROOT = join(import.meta.dirname, '..', '..');
const read = path => readFileSync(join(ROOT, path), 'utf8');
const folderOf = name => (name === '@hornhoof/protocol' ? 'packages/protocol' : `apps/${name.slice('@hornhoof/'.length)}`);

/* The stages of a Dockerfile, each by its name, the image itself by none. */
const stagesOf = dockerfile => read(dockerfile).split(/^FROM /m).slice(1).map(text => ({ name: / AS (\w+)\n/.exec(text)?.[1] ?? null, text }));
/* What the COPY lines of a stage take from the repository, each source by itself. */
const fromRepository = text => [...text.matchAll(/^COPY (?!--from)(.+)$/gm)].flatMap(match => match[1].split(/\s+/).filter(word => !word.startsWith('--')).slice(0, -1));
/* Our package files: the root's, the lockfile and each workspace's. */
const OWN = ['package-lock.json', ...readProject(ROOT).manifests.map(manifest => relative(ROOT, manifest.path))].sort();
const DOCKERFILES = ['Dockerfile', 'apps/node/Dockerfile'];

/* The stage that builds: the folders it copies whole and the workspaces it then builds. */
function buildStage(dockerfile) {
  const stage = stagesOf(dockerfile).find(item => item.name === 'build').text;
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

for (const dockerfile of DOCKERFILES) {
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

/* A release moves only our own versions, so npm ci takes our package files with them set aside, and the layers it makes
   serve the next release as they are. The image gets the files as they are where it reads them. */
for (const dockerfile of DOCKERFILES) {
  test(`${dockerfile} installs from our package files with our own versions set aside`, () => {
    const stages = stagesOf(dockerfile), manifests = stages.find(stage => stage.name === 'manifests');
    assert.ok(manifests, 'a stage named manifests');
    assert.deepEqual(fromRepository(manifests.text).filter(path => path.endsWith('.json')).sort(), OWN);
    assert.match(manifests.text, /^COPY scripts\/release\/workspace-versions\.mjs /m);
    assert.match(manifests.text, /setAside\('\.'\)/);
    const installing = stages.filter(stage => /\bnpm ci\b/.test(stage.text));
    assert.deepEqual(installing.map(stage => stage.name), ['build', 'deps']);
    for (const stage of installing) {
      const before = stage.text.slice(0, stage.text.search(/\bnpm ci\b/));
      assert.match(before, /^COPY --from=manifests \/app\/ \.\/$/m, stage.name);
      assert.deepEqual(fromRepository(before), [], `${stage.name} copies nothing from the repository before npm ci`);
    }
  });
}

test('Dockerfile gives the image our package files as they are, over those the install took', () => {
  const image = stagesOf('Dockerfile').find(stage => stage.name === null).text;
  const after = image.slice(image.indexOf('COPY --from=deps /app /app\n'));
  assert.ok(after.length < image.length, 'the image copies what deps installed');
  /* It takes the whole tree, and Docker leaves none of them out of it. */
  assert.deepEqual(fromRepository(after), ['.']);
  const ignored = read('.dockerignore').split('\n').map(line => line.trim());
  assert.deepEqual(OWN.filter(path => ignored.includes(path)), []);
});

test('apps/node/Dockerfile gives the image the package files of the node and the protocol as they are', () => {
  const image = stagesOf('apps/node/Dockerfile').find(stage => stage.name === null).text;
  assert.deepEqual(fromRepository(image).filter(path => path.endsWith('.json')).sort(), ['apps/node/package.json', 'packages/protocol/package.json']);
});
