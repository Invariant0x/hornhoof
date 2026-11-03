import { releaseNotes } from './release/changelog.mjs';
import { runCli } from './release/cli.mjs';
import { readProject } from './release/project.mjs';
import { versionParts } from './release/versions.mjs';

runCli(() => {
  const project = readProject(process.cwd());
  const [version = project.version, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Usage: release-notes.mjs [X.N.P]');
  versionParts(version);
  return releaseNotes(project.root, version);
});
