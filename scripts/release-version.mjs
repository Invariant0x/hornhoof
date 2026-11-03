import { runCli } from './release/cli.mjs';
import { turnOf } from './release/git.mjs';
import { readProject, writeVersion } from './release/project.mjs';
import { nextVersion, versionArguments } from './release/versions.mjs';

runCli(() => {
  const { mode, turn } = versionArguments(process.argv.slice(2));
  const project = readProject(process.cwd());
  const version = nextVersion(project.version, mode, mode === 'turn' ? turnOf(project.root, turn) : undefined);
  writeVersion(project, version);
  return `Version ${version}\n`;
});
