import { Terminal } from '@xterm/xterm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachTerminalScroll, readingHistoryLine, restoreHistoryLine, restoreLiveTerminal, scrollTerminal, writeTerminalData } from '../src/ui/terminal-scroll';

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

  it('grows history without moving the reader while alternate output updates both buffers', async () => {
    const term = await fixture(true);
    const normal = term.buffer.normal;
    const alternate = term.buffer.alternate;
    scrollTerminal(term, -10);
    const reading = normal.viewportY;
    writeTerminalData(term, '\r\nALT-NEW');
    await write(term, '');
    const normalText = Array.from({ length: normal.length }, (_, i) => normal.getLine(i)?.translateToString()).join('\n');
    const alternateText = Array.from({ length: alternate.length }, (_, i) => alternate.getLine(i)?.translateToString()).join('\n');
    expect(normal.viewportY).toBe(reading);
    expect(normalText).toContain('ALT-NEW');
    expect(alternateText).toContain('ALT-NEW');
    expect(core(term).buffers.active.hasScrollback).toBe(true);
  });

  it('shows output that came while someone read history once the reader is back, after the screen shrank before its first alternate use', async () => {
    const term = new Terminal({ cols: 20, rows: 7, scrollback: 100 });
    terms.push(term);
    term.open(document.createElement('div'));
    term.resize(20, 5);
    await write(term, `${Array.from({ length: 40 }, (_, i) => `LINE-${i}`).join('\r\n')}\r\n\x1b[?1049hALT-OLD`);
    scrollTerminal(term, -10);
    writeTerminalData(term, '\r\nALT-NEW');
    await write(term, '');
    scrollTerminal(term, 1000);
    const live = term.buffer.active;
    const shown = Array.from({ length: term.rows }, (_, i) => live.getLine(live.viewportY + i)?.translateToString(true)).join('\n');
    expect(live.type).toBe('alternate');
    expect(shown).toContain('ALT-OLD\nALT-NEW');
  });

  it('keeps the reader in place when the program leaves its alternate screen and writes on while history is read', async () => {
    const term = await fixture(true);
    scrollTerminal(term, -10);
    const reading = term.buffer.active.viewportY;
    writeTerminalData(term, '\x1b[?1049lBACK-1\r\n');
    await write(term, '');
    writeTerminalData(term, 'BACK-2\r\n');
    await write(term, '');
    expect(term.buffer.active.viewportY).toBe(reading);
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

  it('leaves the reading place alone when the viewport reports no whole line', async () => {
    const term = await fixture();
    scrollTerminal(term, -10);
    Object.assign(core(term).viewport, { getLinesScrolled: () => 0 });
    attachTerminalScroll(term);
    const event = new WheelEvent('wheel', { deltaY: -1, cancelable: true });
    expect(core(term)._customWheelEventHandler(event)).toBe(false);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY - 10);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    [-1, -13],
    [1, -7],
    [0, -7],
  ])('scrolls three lines without a viewport for wheel delta %s', async (deltaY, offset) => {
    const term = await fixture();
    scrollTerminal(term, -10);
    const viewport = core(term).viewport;
    Reflect.deleteProperty(core(term), 'viewport');
    attachTerminalScroll(term);
    Object.assign(core(term), { viewport });
    const event = new WheelEvent('wheel', { deltaY, cancelable: true });
    expect(core(term)._customWheelEventHandler(event)).toBe(false);
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY + offset);
    expect(event.defaultPrevented).toBe(true);
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

  it('reads and restores a scrolled-up history line on both normal and alternate screens', async () => {
    const normal = await fixture();
    expect(readingHistoryLine(normal)).toBeNull();
    scrollTerminal(normal, -12);
    const normalLine = readingHistoryLine(normal);
    expect(normalLine).toBe(normal.buffer.active.baseY - 12);
    normal.scrollToBottom();
    restoreHistoryLine(normal, normalLine!);
    expect(normal.buffer.active.viewportY).toBe(normalLine);
    restoreHistoryLine(normal, 9999);
    expect(normal.buffer.active.viewportY).toBe(normal.buffer.active.baseY);

    const alt = await fixture(true);
    expect(readingHistoryLine(alt)).toBeNull();
    scrollTerminal(alt, -10);
    const altLine = readingHistoryLine(alt);
    expect(altLine).toBe(alt.buffer.normal.baseY - 10);
    restoreLiveTerminal(alt);
    expect(alt.buffer.active.type).toBe('alternate');
    restoreHistoryLine(alt, altLine!);
    expect(core(alt).buffers.active.hasScrollback).toBe(true);
    expect(alt.buffer.normal.viewportY).toBe(altLine);
    restoreLiveTerminal(alt);
    restoreHistoryLine(alt, 9999);
    expect(alt.buffer.active.type).toBe('alternate');
  });
});
