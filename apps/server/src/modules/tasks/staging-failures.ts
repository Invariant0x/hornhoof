import { TEST_LOG_BYTES } from '@hornhoof/protocol';
import { z } from 'zod';
import { RepoPath } from './review-schema.js';
import type { StagingFailureTest } from './staging-split.js';

const File = RepoPath.refine(file => !/^[a-z]:/i.test(file));
const Scope = z.strictObject({
  adapter: z.enum(['vitest', 'pytest']), suiteId: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/), root: z.union([z.literal('.'), File]),
  files: z.array(File).min(1).max(10_000).refine(files => new Set(files).size === files.length), log: z.string().max(TEST_LOG_BYTES),
});
export type StagingFailureLog = z.infer<typeof Scope>;
interface FailureFrame { count: number; cases: { file: string; test: string }[] }

function summary(text: string, pattern: RegExp): { count: number; line: string } | null {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) return null;
  const count = Number(matches[0]![1]);
  return count > 0 ? { count, line: matches[0]![0] } : null;
}

function vitestFrame(text: string): FailureFrame | null {
  const end = summary(text, /^\s*Tests\s+(\d+) failed[^\n]*$/gm);
  if (!end || [...text.matchAll(/^ RUN\s+v/gm)].length !== 1) return null;
  const cases = [...text.matchAll(/^\s*FAIL\s+(\S+) > (.+)$/gm)].map(match => ({ file: match[1]!, test: match[2]! }));
  return { count: end.count, cases };
}

function pytestFrame(text: string): FailureFrame | null {
  if ([...text.matchAll(/short test summary info/g)].length !== 1) return null;
  const section = text.slice(text.indexOf('short test summary info'));
  const end = summary(section, /^[= ]*(\d+) failed[^\n]* in \d+(?:\.\d+)?s[= ]*$/gm);
  if (!end || /\b\d+ errors?\b/.test(end.line)) return null;
  const cases = [...section.matchAll(/^FAILED\s+(\S+?)::(.+?)(?: - .*)?$/gm)].map(match => ({ file: match[1]!, test: match[2]! }));
  if (cases.some(item => !/^[^\s[\]]+(?:\[[^\s[\]]*\])?$/.test(item.test))) return null;
  return { count: end.count, cases };
}

function labels(scope: StagingFailureLog, frame: FailureFrame): StagingFailureTest[] | null {
  const selected = new Set(scope.files), result: StagingFailureTest[] = [];
  for (const item of frame.cases) {
    if (!File.safeParse(item.file).success) return null;
    const file = scope.root === '.' ? item.file : `${scope.root}/${item.file}`;
    if (!selected.has(file)) return null;
    result.push({ suiteId: scope.suiteId, file, test: item.test });
  }
  const distinct = new Set(result.map(item => `${item.file}\0${item.test}`));
  return result.length === frame.count && distinct.size === result.length ? result : null;
}

/* Text compatibility only. The caller must bind the complete log to authenticated native run/part/pin evidence. */
export function parseStagingFailureTests(input: StagingFailureLog): StagingFailureTest[] | null {
  const parsed = Scope.safeParse(input);
  if (!parsed.success) return null;
  const text = parsed.data.log.replaceAll('\r\n', '\n');
  if (/[\u0000-\u0008\u000b-\u001f\u007f]|\[\d+ bytes left out\]|Unhandled Errors?|Unhandled Rejection|^ERROR(?:\s|$)/m.test(text)) return null;
  const frame = parsed.data.adapter === 'vitest' ? vitestFrame(text) : pytestFrame(text);
  return frame ? labels(parsed.data, frame) : null;
}
