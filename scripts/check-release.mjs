import { checkArguments, checkRelease } from './release/check.mjs';
import { runCli } from './release/cli.mjs';
import { readProject } from './release/project.mjs';

runCli(() => checkRelease(readProject(process.cwd()), checkArguments(process.argv.slice(2))));
