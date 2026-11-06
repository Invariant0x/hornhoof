import { afterEach, describe, expect, it } from 'vitest';
import { StreamMask } from '../src/terminal/mask.js';
import { hasTmux, host, job, sent, setUp, tmux, until } from './terminal-host-helpers.js';

/* Made up, built from pieces: a value whose start is a letter that also ends terminal sequences. */
const secretFrom = (first: string) => `${first}${'fake-'}${'0123456789abcdef'}`;
const rest = (secret: string) => secret.slice(1);
const allOf = (mask: StreamMask, pieces: string[]) => pieces.map(piece => mask.push(piece)).join('') + mask.flush();

describe('the end of a finished terminal sequence is not text that could start a secret', () => {
  it.each(['H', 'm', 'K', 'J', 'h', 'l'])('a frame that ends in the sequence %s goes out whole, at once', final => {
    const mask = new StreamMask(() => [secretFrom(final)]);
    expect(mask.push(`text\x1b[1;2${final}`)).toBe(`text\x1b[1;2${final}`);
    expect(mask.flush()).toBe('');
  });

  it.each(['\x1b[?25h', '\x1b[?1049l', '\x1b[2 q', '\x1b[>4;2m'])('so does a sequence with other parameters, %j', sequence => {
    const mask = new StreamMask(() => [secretFrom(sequence.at(-1)!)]);
    expect(mask.push(sequence)).toBe(sequence);
  });

  it('holds no sequence for a base64 form either', () => {
    const secret = secretFrom('H');
    const first = Buffer.from(secret).toString('base64')[0]!;
    const mask = new StreamMask(() => [secret]);
    expect(mask.push(`\x1b[2${first}`)).toBe(`\x1b[2${first}`);
  });

  it('sends a thousand frames in a thousand pieces, when many secrets start with their last letters', () => {
    const mask = new StreamMask(() => ['H', 'm', 'K', 'J'].map(secretFrom));
    const frames = Array.from({ length: 1000 }, (_, at) => `\x1b[${(at % 20) + 1};1H\x1b[2Kline ${at}\x1b[0m\x1b[22;3H`);
    const held = frames.filter(frame => mask.push(frame) !== frame);
    expect(held).toEqual([]);
  });
});

describe('what the mask still hides, however the pieces fall', () => {
  it.each(['H', 'm', 'K'])('the rest of a secret after a sequence that ends in its first letter, %s', final => {
    const secret = secretFrom(final);
    const out = allOf(new StreamMask(() => [secret]), [`\x1b[1;2${final}`, rest(secret), ' end']);
    expect(out).not.toContain(rest(secret).slice(0, 2));
    expect(out.endsWith(' end')).toBe(true);
  });

  it('nothing of a frame that goes on with other text', () => {
    const mask = new StreamMask(() => [secretFrom('H')]);
    expect(allOf(mask, ['\x1b[1;2H', 'plain text ', 'Hold on'])).toBe('\x1b[1;2Hplain text Hold on');
  });

  it('a whole secret in one piece, after a sequence', () => {
    const secret = secretFrom('H');
    expect(allOf(new StreamMask(() => [secret]), [`\x1b[1;2H${secret} end`])).toBe('\x1b[1;2H[hidden] end');
  });

  /* Every place a stream can be cut, around sequences, in every form the secret can show in. */
  it.each(['plain', 'base64', 'base64url'] as const)('a secret in %s, cut in two anywhere', form => {
    const secret = secretFrom('H');
    const shown = form === 'plain' ? secret : Buffer.from(secret).toString(form);
    const text = `\x1b[5;1H\x1b[2Kkey ${shown}\x1b[0m\x1b[22;3H`;
    for (let cut = 1; cut < text.length; cut++) {
      const out = allOf(new StreamMask(() => [secret]), [text.slice(0, cut), text.slice(cut)]);
      expect(out, `cut at ${cut}`).not.toContain(shown);
      expect(out, `cut at ${cut}`).toContain('[hidden]');
    }
  });

  it('a letter that is text, not the end of a sequence', () => {
    const secret = secretFrom('H');
    for (const text of ['see H', '[1;2H', '\x1b]0;title H', '\x1bPdata H', '\x1b[1;2H\x1b[0mH']) {
      const mask = new StreamMask(() => [secret]);
      expect(mask.push(text), JSON.stringify(text)).toBe(text.slice(0, -1));
      expect(mask.flush()).toBe('H');
    }
  });

  it('a sequence not finished yet, when its next character could start a secret', () => {
    const secret = secretFrom('2');
    const mask = new StreamMask(() => [secret]);
    expect(mask.push('\x1b[1;2')).toBe('\x1b[1;');
  });

  it('a longer start of a secret after a letter that would have ended a sequence', () => {
    const secret = secretFrom('t');
    const mask = new StreamMask(() => [secret]);
    expect(mask.push('\x1b[1;2tfake-01')).toBe('\x1b[1;2');
    expect(mask.flush()).toBe('[hidden]');
    expect(mask.push(secret.slice('tfake-01'.length))).toBe('[hidden]');
  });

  it('a long start of a secret when the screen goes quiet on it, and the rest after', () => {
    const secret = secretFrom('H');
    const mask = new StreamMask(() => [secret]);
    expect(mask.push('\x1b[1;2H') + mask.push('fake-012') + mask.flush() + mask.push(secret.slice('Hfake-012'.length))).not.toContain('3456');
  });
});

describe.skipIf(!hasTmux)('what a real screen sends through the mask', () => {
  afterEach(() => host.stop());

  const FRAMES = 12;
  const frames = async (secrets: string[], key: string) => {
    await setUp({ secrets: () => secrets });
    await host.run(job(key, 'hello', { jobId: `job-${key}` }));
    const name = host['agents'].get(key)!.name;
    await host.open({ type: 'term.open', termId: key, agentKey: key, cols: 80, rows: 24, write: false });
    await until(() => sent.some(m => m.type === 'term.data'));
    await tmux.run(['respawn-pane', '-k', '-t', name, 'sh', '-c',
      `i=1; while [ $i -le ${FRAMES} ]; do printf '\\033[5;1Htick-%s\\033[22;3H' $i; i=$((i+1)); sleep 0.25; done; sleep 30`]);
    const data = () => sent.flatMap(m => (m.type === 'term.data' && m.termId === key ? [String(m.data)] : []));
    await until(() => data().join('').includes(`tick-${FRAMES}`), 10_000);
    await new Promise(done => setTimeout(done, 300));
    return data();
  };

  it('splits no frame when no secret starts with the letter its last sequence ends in', async () => {
    expect((await frames([secretFrom('z')], 'control')).filter(frame => frame === 'H')).toEqual([]);
  });

  it('splits no frame when a secret starts with that letter', async () => {
    expect((await frames([secretFrom('H')], 'split')).filter(frame => frame === 'H')).toEqual([]);
  });
});
