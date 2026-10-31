import { describe, expect, it } from 'vitest';
import { installsIn, missingIn } from '../src/modules/tools/stumbles.js';

describe('where agents stumbled', () => {
  it('names the command a shell did not find, in the words of bash, dash, zsh and env', () => {
    expect(missingIn('bash: line 1: ps: command not found')).toEqual([{ what: 'ps', kind: 'command' }]);
    expect(missingIn('sh: 1: free: not found')).toEqual([{ what: 'free', kind: 'command' }]);
    expect(missingIn('zsh: command not found: jq')).toEqual([{ what: 'jq', kind: 'command' }]);
    expect(missingIn("/usr/bin/env: 'python': No such file or directory")).toEqual([{ what: 'python', kind: 'command' }]);
    expect(missingIn('Error: not found')).toEqual([]);
  });

  it('names the package of a module that was not installed, not a file the agent wrote', () => {
    expect(missingIn("ModuleNotFoundError: No module named 'yaml.loader'")).toEqual([{ what: 'yaml', kind: 'python module' }]);
    expect(missingIn("Error: Cannot find module '@scope/tool/dist/index.js'")).toEqual([{ what: '@scope/tool', kind: 'node module' }]);
    expect(missingIn("Cannot find package 'zod' imported from /work/a.mjs")).toEqual([{ what: 'zod', kind: 'node module' }]);
    expect(missingIn("Cannot find module './local.js'")).toEqual([]);
    expect(missingIn("Cannot find module '/tmp/run.mjs'")).toEqual([]);
    expect(missingIn("Cannot find module 'node:sqlite'")).toEqual([]);
  });

  it("finds what an agent installed for itself or the machine, not a project's own dependencies", () => {
    expect(installsIn('sudo apt-get -y install  jq && jq --version')).toEqual(['sudo apt-get -y install jq']);
    expect(installsIn('python3 -m pip install requests; python3 run.py')).toEqual(['python3 -m pip install requests']);
    expect(installsIn('/bin/bash,-lc,npm install --save-dev x -g')).toEqual(['npm install --save-dev x -g']);
    expect(installsIn('npx playwright install chromium')).toEqual(['npx playwright install chromium']);
    expect(installsIn('npm install && npm test')).toEqual([]);
    expect(installsIn('git add -A && git commit -m "install docs"')).toEqual([]);
  });
});
