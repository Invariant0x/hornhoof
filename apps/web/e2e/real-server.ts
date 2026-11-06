import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

type ServerOptions = { cwd: string; publicUrl: string; invalidBoot: string };

export async function startServer<Boot>(script: string, { cwd, publicUrl, invalidBoot }: ServerOptions): Promise<Boot & { stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, HH_PUBLIC_URL: publicUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const lines = createInterface({ input: child.stdout });
  const boot = await new Promise<Boot>((resolveBoot, rejectBoot) => {
    lines.once('line', line => {
      try {
        resolveBoot(JSON.parse(line) as Boot);
      } catch (err) {
        rejectBoot(new Error(`${invalidBoot}: ${line} (${String(err)})\n${stderr}`));
      }
    });
    child.once('exit', code => {
      rejectBoot(new Error(`Real server exited early (${code}):\n${stderr}`));
    });
  });
  return {
    ...boot,
    stop: () =>
      new Promise<void>(done => {
        if (child.exitCode !== null) return done();
        child.once('exit', () => done());
        child.stdin.end();
      }),
  };
}
