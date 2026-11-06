/* Test-only composition of the existing node invocation builder and a real framework process. */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestSuite, type Command } from '@hornhoof/protocol';

type Request = { suite: unknown; files: string[]; checkout: string; filesPath: string };
type Adapter = { buildTestInvocation(suite: TestSuite, files: string[], context: { checkout: string; filesPath: string }): Promise<{ command: Command; env: Record<string, string> }> };
const request = JSON.parse(readFileSync(process.argv[2]!, 'utf8')) as Request;
const moduleUrl = new URL('../../../../node/src/test-environment.ts', import.meta.url);
const adapter = await import(moduleUrl.href) as Adapter;
const invocation = await adapter.buildTestInvocation(TestSuite.parse(request.suite), request.files, request);
console.log('HH588_FIXTURE_COMMAND ' + JSON.stringify({ fixtureOnly: true, command: invocation.command }));
const child = spawn(invocation.command.program, invocation.command.args, {
  cwd: resolve(request.checkout, invocation.command.cwd), stdio: 'inherit',
  env: { ...process.env, ...invocation.env, PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1', PYTEST_ADDOPTS: '', PYTHONDONTWRITEBYTECODE: '1' },
});
process.once('SIGTERM', () => { child.kill('SIGTERM'); });
const code = await new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('close', (code, signal) => {
    console.log('HH588_FIXTURE_PROCESS ' + JSON.stringify({ fixtureOnly: true, code, signal }));
    resolve(code ?? 1);
  });
});
process.exitCode = code;
