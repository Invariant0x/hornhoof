import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalScroll, restoreLiveTerminal, scrollTerminal } from '../src/ui/terminal-scroll';

const terms: Terminal[] = [];
type TestCore = { buffers: { active: { hasScrollback: boolean } }; viewport: { getLinesScrolled(event: WheelEvent): number }; _customWheelEventHandler(event: WheelEvent): boolean };
const core = (term: Terminal): TestCore => (term as unknown as { _core: TestCore })._core;

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>(resolve => term.write(data, resolve));
}

async function fixture(alternate = false) {
  const term = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
  terms.push(term);
  term.open(document.createElement('div'));
  await write(term, `${Array.from({ length: 40 }, (_, i) => `LINE-${i}`).join('\r\n')}\r\n`);
  if (alternate) await write(term, '\x1b[?1049hALT-OLD');
  return term;
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
});

afterEach(() => {
  for (const term of terms.splice(0)) term.dispose();
});

describe('local terminal scrollback', () => {
  it('scrolls the normal buffer without changing the active buffer', async () => {
    const term = await fixture();
    const before = term.buffer.active.viewportY;
    scrollTerminal(term, -10);
    expect(term.buffer.active.viewportY).toBe(before - 10);
    expect(core(term).buffers.active.hasScrollback).toBe(true);
  });

  it('exposes normal history during alternate screen and restores the same live buffer', async () => {
    const term = await fixture(true);
    const normal = term.buffer.normal;
    expect(term.buffer.active.type).toBe('alternate');
    scrollTerminal(term, -10);
    expect(normal.viewportY).toBe(normal.baseY - 10);
    expect(core(term).buffers.active.hasScrollback).toBe(true);
    scrollTerminal(term, -5);
    expect(normal.viewportY).toBe(normal.baseY - 15);
    restoreLiveTerminal(term);
    expect(term.buffer.active.type).toBe('alternate');
    await write(term, '\rALT-NEW');
    expect(Array.from({ length: term.buffer.active.length }, (_, i) => term.buffer.active.getLine(i)?.translateToString()).join('\n')).toContain('ALT-NEW');
  });

  it('returns to the live alternate screen when the wheel reaches the bottom', async () => {
    const term = await fixture(true);
    scrollTerminal(term, -10);
    expect(core(term).buffers.active.hasScrollback).toBe(true);
    scrollTerminal(term, 1000);
    expect(term.buffer.active.type).toBe('alternate');
  });

  it('leaves alternate input and output alone when there is no normal history', async () => {
    const term = new Terminal({ cols: 20, rows: 5, scrollback: 100 });
    terms.push(term);
    await write(term, '\x1b[?1049hALT-ONLY');
    const before = term.buffer.active.viewportY;
    scrollTerminal(term, -10);
    expect(term.buffer.active.type).toBe('alternate');
    expect(term.buffer.active.viewportY).toBe(before);
    expect(term.buffer.active.getLine(0)?.translateToString()).toContain('ALT-ONLY');
  });

  it('suppresses wheel-generated terminal data while scrolling locally', async () => {
    const term = await fixture();
    const data = vi.fn();
    term.onData(data);
    Object.assign(core(term).viewport!, { getLinesScrolled: (event: WheelEvent) => event.deltaY });
    attachTerminalScroll(term);
    const handled = (core(term) as unknown as { _customWheelEventHandler(event: WheelEvent): boolean })._customWheelEventHandler(new WheelEvent('wheel', { deltaY: -3 }));
    expect(handled).toBe(false);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - 3);
    expect(data).not.toHaveBeenCalled();
  });
});
