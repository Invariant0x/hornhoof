import { readFileSync } from 'node:fs';

/* A capture of a real program, with its escape codes. */
export const real = (name: string): string => readFileSync(new URL(`./fixtures/real-screens/${name}.ansi`, import.meta.url), 'utf8');

/* A real Codex screen with its footer gone: no capture shows one, and only a version to come may. */
export const withoutFooter = (shown: string): string => shown.slice(0, shown.lastIndexOf('\n', shown.indexOf('GPT-6.1-Sol')));

/* The prompt's row of real Codex, which shows its dim placeholder while nothing is typed. */
export const codexPrompt = (input: string): string => `› ${input || '\x1b[2mAsk Codex to do anything\x1b[0m'}\n`;
