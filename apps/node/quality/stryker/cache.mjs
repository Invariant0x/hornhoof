import { createHash } from 'node:crypto';
import { readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ignored = new Set(['node_modules', 'reports', '.stryker-tmp', 'target', 'coverage', '.git']);

async function filesIn(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesIn(root, file));
    else if (entry.isFile()) files.push(path.relative(root, file));
  }
  return files.sort();
}

async function fingerprint(root, environment, runtime) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([runtime, Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))]));
  for (const file of await filesIn(root)) {
    hash.update(JSON.stringify([file, (await readFile(path.join(root, file))).toString('base64')]));
  }
  return hash.digest('hex') + '\n';
}

async function previousStamp(file) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Clear Stryker results when any helper, setting, lockfile or environment input changes. */
export async function prepareCache(root, environment = process.env, runtime = JSON.stringify([process.versions, process.platform, process.arch])) {
  const stamp = await fingerprint(root, environment, runtime);
  const directory = path.join(root, 'reports');
  const file = path.join(directory, 'fingerprint');
  if (await previousStamp(file) === stamp) return false;
  await mkdir(directory, { recursive: true });
  await rm(path.join(directory, 'incremental.json'), { force: true });
  await writeFile(file, stamp);
  return true;
}
