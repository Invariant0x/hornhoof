import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Ctx } from '../../app.js';

/* Hornhoof's own files, of the build that runs here: in its image the source lies beside what was built from it. */
const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
/* What was installed or built, and so is no source of Hornhoof's. */
const SKIP = new Set(['node_modules', 'dist', '.git', 'coverage']);
const MAX_ANSWER = 30_000;
const MAX_HITS = 200;
const MAX_LINES = 400;
/* A search leaves out bigger files, such as the snapshots of the database's schema; path still reads them. */
const SEARCHED_BYTES = 256_000;

const say = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });
const shown = (full: string): string => relative(ROOT, full).split(sep).join('/');

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (entry.isFile()) yield full;
  }
}

function search(under: string, text: string): string {
  let pattern: RegExp;
  try {
    pattern = new RegExp(text, 'i');
  } catch {
    pattern = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  }
  const hits: string[] = [];
  for (const file of statSync(under).isDirectory() ? files(under) : [under]) {
    if (statSync(file).size > SEARCHED_BYTES) continue;
    const content = readFileSync(file, 'utf8');
    if (content.includes('\0')) continue;
    for (const [i, line] of content.split('\n').entries()) {
      if (!pattern.test(line)) continue;
      if (hits.length === MAX_HITS) return `${hits.join('\n')}\nMore lines match: narrow it with path or a longer search.`;
      hits.push(`${shown(file)}:${i + 1}: ${line.trim().slice(0, 300)}`);
    }
  }
  return hits.length ? hits.join('\n') : `Nothing matches ${text}.`;
}

function read(full: string, from: number): string {
  if (statSync(full).isDirectory()) {
    const entries = readdirSync(full, { withFileTypes: true }).filter(entry => !SKIP.has(entry.name));
    return entries.map(entry => (entry.isDirectory() ? `${entry.name}/` : entry.name)).sort().join('\n');
  }
  const lines = readFileSync(full, 'utf8').split('\n');
  const out: string[] = [];
  let size = 0;
  for (let n = from; n <= lines.length && out.length < MAX_LINES; n++) {
    const line = `${n}: ${lines[n - 1]}`;
    if (size + line.length > MAX_ANSWER) break;
    out.push(line);
    size += line.length + 1;
  }
  const next = from + out.length;
  return next <= lines.length ? `${out.join('\n')}\nThe file goes on from line ${next} of ${lines.length}: read on with from.` : out.join('\n');
}

/* The orchestrator reads how Hornhoof is made, to say how and where anything in it works (Ivan's word of 16 November 2026). */
export function registerSourceTool(server: McpServer, ctx: Ctx): void {
  server.registerTool(
    'source',
    {
      description:
        `Hornhoof's own source, exactly the build that runs here (version ${ctx.config.version}, commit ${ctx.config.commit}): the server (apps/server), the node on each machine (apps/node), ` +
        "the screens (apps/web), the protocol between them (packages), the templates of departments, roles and skills, the docs (docs/architecture/module-map.md says where each part lives), the guide and the database's migrations (apps/server/drizzle). " +
        'Use it whenever someone asks how or where something in Hornhoof works, or why it behaves as it does, and answer with the file and line; logs and database show how it runs right now. ' +
        'search: a regular expression, any case, looked for in every file or under path; each line found comes as path:line: text. path: a file, its lines numbered from from, or a folder, with what it holds.',
      inputSchema: {
        search: z.string().min(1).max(300).optional(),
        path: z.string().trim().min(1).max(500).optional().describe('A file or folder from the top of the source, such as apps/server/src/app.ts.'),
        from: z.number().int().min(1).optional().describe('The first line of the file to show.'),
      },
    },
    async ({ search: text, path = '.', from = 1 }) => {
      const full = resolve(ROOT, path);
      const inside = relative(ROOT, full);
      if (inside.startsWith('..') || isAbsolute(inside)) return say(`${path} is outside Hornhoof's source. Give a path from its top, such as apps/server/src.`, true);
      try {
        return say(text ? search(full, text) : read(full, from));
      } catch {
        return say(`There is no ${path} in Hornhoof's source. Read the folder above it to see what is there.`, true);
      }
    },
  );
}
