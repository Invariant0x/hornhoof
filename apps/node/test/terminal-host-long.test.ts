import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { SECRET, codexJob, hasTmux, host, job, kimiJob, setUp } from './terminal-host-helpers.js';

/* A message as people write them: over 4000 characters of Russian in lines, with quotes, $, `, \ and emoji. */
const LONG = Array.from(
  { length: 40 },
  (_, i) => `${i + 1}. Сообщение «для проверки» с $HOME, \`ls -la\`, обратной \\ чертой и 🙂: строка длинная, чтобы весь текст был больше 4000 знаков.`,
).join('\n');
/* One line far longer than a terminal keeps for a line it has not read yet. */
const LINE = 'Длинная строка без переводов, «кавычки», $PATH и 🙂. '.repeat(120);

const programs = [
  ['Claude Code', job],
  ['Codex', codexJob],
  ['Kimi Code', kimiJob],
] as const;

describe.skipIf(!hasTmux)('long messages typed into an agent program', () => {
  afterEach(async () => host?.stop());

  it('are as long as the cases they stand for', () => {
    expect(LONG.length).toBeGreaterThan(4000);
    expect(LONG.split('\n')).toHaveLength(40);
    expect(Buffer.byteLength(LINE)).toBeGreaterThan(8 * 1024);
  });

  it.each(programs)('reach %s whole and in order right after it starts', async (_, make) => {
    await setUp();
    expect(await host.run(make(`long-${make.name}`, LONG))).toMatchObject({ ok: true, result: `echo: ${LONG}` });
  });

  it.each(programs)('reach %s whole as one line longer than a terminal line', async (_, make) => {
    await setUp();
    expect(await host.run(make(`line-${make.name}`, LINE))).toMatchObject({ ok: true, result: `echo: ${LINE}` });
  });

  it('wait for the input box of a Claude Code that says it started before it reads what is typed', async () => {
    await setUp();
    const res = await host.run(job('long-early', LONG, { env: { FAKE_SECRET: SECRET, FAKE_INPUT_MS: '1500' } }));
    expect(res).toMatchObject({ ok: true, result: `echo: ${LONG}` });
  });

  it.each([
    ['Claude Code', job],
    ['Kimi Code', kimiJob],
  ] as const)('reach %s whole through a file when it kept only the end of what was typed', async (_, make) => {
    await setUp();
    const base = make(`tail-${make.name}`, LONG);
    const res = await host.run({ ...base, input: { ...base.input, env: { ...base.input.env, FAKE_KEEP_TAIL: '75' } } });
    expect(res.ok).toBe(true);
    const [said, notice = ''] = res.result.split('\n');
    expect(said).toBe(`echo: ${LONG.slice(-75)}`);
    expect(notice).toMatch(/^Hornhoof: this message reached you cut short\b/);
    const file = notice.match(/ in (\/\S+\.md)\b/)?.[1];
    expect(file).toBeDefined();
    expect(readFileSync(file!, 'utf8')).toBe(LONG);
  });
});
