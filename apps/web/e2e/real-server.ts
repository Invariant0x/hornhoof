import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

type ServerOptions = { cwd: string; publicUrl: string; invalidBoot: string; env?: NodeJS.ProcessEnv };

function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise<void>(done => {
    child.once('exit', () => done());
    child.stdin.end();
  });
}

function readBootLine<Boot>(child: ChildProcessWithoutNullStreams, invalidBoot: string, readStderr: () => string): Promise<Boot> {
  const lines = createInterface({ input: child.stdout });
  return new Promise<Boot>((resolveBoot, rejectBoot) => {
    const onError = (err: Error) => finish(() => rejectBoot(err));
    const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
      finish(() => rejectBoot(new Error(`Real server exited early (${code ?? signal}):\n${readStderr()}`)));
    const finish = (fn: () => void) => {
      child.off('error', onError);
      child.off('exit', onExit);
      lines.close();
      child.stdout.resume();
      fn();
    };
    lines.once('line', line => {
      try {
        const parsed = JSON.parse(line) as Boot;
        finish(() => resolveBoot(parsed));
      } catch (err) {
        finish(() => rejectBoot(new Error(`${invalidBoot}: ${line} (${String(err)})\n${readStderr()}`)));
        child.kill();
      }
    });
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

export async function startServer<Boot>(script: string, { cwd, publicUrl, invalidBoot, env }: ServerOptions): Promise<Boot & { stop: () => Promise<void> }> {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd,
    env: { ...process.env, ...env, HH_PUBLIC_URL: publicUrl },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += String(chunk);
  });
  const boot = await readBootLine<Boot>(child, invalidBoot, () => stderr);
  return { ...boot, stop: () => stopChild(child) };
}
