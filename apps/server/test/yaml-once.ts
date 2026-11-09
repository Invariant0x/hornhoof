import { vi } from 'vitest';

/* Every server a test builds reads the role and skill templates again, and parsing their YAML was most of the time it
   took to build one. YAML is not our code, so each test file parses a text once and gives every reader its own copy; our
   loader still reads, checks and assembles the templates each time it is asked to (templates-once.ts asks once a file).
   Parsing with options or a reviver, and a text that is no YAML, still goes to YAML each time. */
const parsed = new Map<string, unknown>();
const reads = new Map<string, number>();

export const readsOf = (text: string): number => reads.get(text) ?? 0;

vi.mock('yaml', async importOriginal => {
  const yaml = await importOriginal<typeof import('yaml')>();
  const once = (text: string): unknown => {
    if (!parsed.has(text)) {
      parsed.set(text, yaml.parse(text));
      reads.set(text, readsOf(text) + 1);
    }
    return structuredClone(parsed.get(text));
  };
  const parse = ((text: string, ...rest: unknown[]) =>
    rest.length === 0 && typeof text === 'string' ? once(text) : (yaml.parse as (...args: unknown[]) => unknown)(text, ...rest)) as typeof yaml.parse;
  return { ...yaml, parse };
});
