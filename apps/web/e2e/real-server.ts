import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

type ServerOptions = { cwd: string; publicUrl: string; invalidBoot: string; env?: NodeJS.ProcessEnv };

/* A server answers /api/build, which the page asks every few minutes, only with a page of its own to name. Left to find the
   built app in this checkout, it answers 404 wherever the app was not built, and the browser logs each as a console error.
   A real server gets a small page of its own, as a production one has, named by HH_WEB_DIST in its script's configuration. */
export function pageFolder(prefix: string): string {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(folder, 'index.html'), '<!doctype html><title>Hornhoof</title>\n');
  return folder;
}

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
