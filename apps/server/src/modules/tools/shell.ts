import { spawn } from 'node:child_process';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/* Answers longer than this are cut, as the other tools' are. */
const MAX_ANSWER = 30_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const seconds = (n: number) => `${n} second${n === 1 ? '' : 's'}`;

/* The command under sh, with what it wrote to its output and its errors in the order it wrote them. A command that runs
   out of time is stopped with every process it started. */
function run(command: string, timeoutMs: number): Promise<{ output: string; code: number | null; stopped: boolean }> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let stopped = false;
    const take = (chunk: Buffer) => {
      if (output.length <= MAX_ANSWER) output += chunk.toString('utf8');
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const timer = setTimeout(() => {
      stopped = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ output: err.message, code: null, stopped });
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ output, code, stopped });
    });
  });
}

/* Any command in the container Hornhoof's server runs in, with its code, settings and files (Ivan's word of 17 November
   2026): the orchestrator looks at its own system and changes it, as far as that container reaches. */
export function registerShellTool(server: McpServer): void {
  server.registerTool(
    'shell',
    {
      description:
        "Runs any shell command inside the container Hornhoof's server runs in, as the server itself, with its code, its settings and environment, and its files: " +
        'to look at how your own system is made and runs, and to change it. Each call runs sh -c in a new process; what it writes to its output and its errors comes back, ' +
        'with its exit code. It stops after timeoutSeconds (60 if not given, at most 600). A change to the files of the running build lasts until the next update brings a new image.',
      inputSchema: { command: z.string().trim().min(1).max(20_000), timeoutSeconds: z.number().int().min(1).max(600).optional() },
    },
    async ({ command, timeoutSeconds = 60 }) => {
      const { output, code, stopped } = await run(command, timeoutSeconds * 1000);
      const head = stopped ? `Stopped after ${seconds(timeoutSeconds)}.` : code === null ? 'The command did not start.' : `Exit code ${code}.`;
      const body = output.length > MAX_ANSWER ? `${output.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]` : output;
      return say(`${head}\n${body}`, stopped || code !== 0);
    },
  );
}
