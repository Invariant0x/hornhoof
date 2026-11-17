import { inflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { pictureType } from '../src/modules/tasks/attachments.js';
import { PAINT_OPTIONS, renderOperatorScreen, renderOperatorScreenSvg } from '../src/modules/program-operator/screen.js';

type DecodedPng = {
  width: number;
  height: number;
  pixel(x: number, y: number): [number, number, number, number];
};

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function decodePng(buf: Buffer): DecodedPng {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.subarray(0, 8).equals(sig)).toBe(true);
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Buffer[] = [];
  let sawIend = false;

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const data = buf.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      expect(bitDepth).toBe(8);
      expect([2, 6]).toContain(colorType);
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    }
  }
  expect(sawIend).toBe(true);
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  expect(raw.length).toBe(height * (1 + stride));
  const pixels = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)]!;
    const srcRow = y * (1 + stride) + 1;
    const dstRow = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[srcRow + i]!;
      const left = i >= channels ? pixels[dstRow + i - channels]! : 0;
      const up = y > 0 ? pixels[dstRow - stride + i]! : 0;
      const upLeft = y > 0 && i >= channels ? pixels[dstRow - stride + i - channels]! : 0;
      const recon =
        filter === 0 ? x :
        filter === 1 ? x + left :
        filter === 2 ? x + up :
        filter === 3 ? x + ((left + up) >> 1) :
        x + paeth(left, up, upLeft);
      pixels[dstRow + i] = recon & 0xff;
    }
  }

  return {
    width,
    height,
    pixel(x: number, y: number): [number, number, number, number] {
      const idx = (y * width + x) * channels;
      return [pixels[idx]!, pixels[idx + 1]!, pixels[idx + 2]!, channels === 4 ? pixels[idx + 3]! : 255];
    },
  };
}

function measureGrid() {
  const a = renderOperatorScreenSvg({ cells: '', cols: 10, rows: 2, secrets: [] });
  const b = renderOperatorScreenSvg({ cells: '', cols: 20, rows: 4, secrets: [] });
  const cellWidth = (b.width - a.width) / 10;
  const cellHeight = (b.height - a.height) / 2;
  const padX = (a.width - 10 * cellWidth) / 2;
  const padY = (a.height - 2 * cellHeight) / 2;
  return { cellWidth, cellHeight, padX, padY };
}

function cellSignature(img: DecodedPng, col: number, row: number, geom: ReturnType<typeof measureGrid>): string {
  const x0 = geom.padX + col * geom.cellWidth;
  const y0 = geom.padY + row * geom.cellHeight;
  const parts: number[] = [];
  for (let y = y0; y < y0 + geom.cellHeight; y++) {
    for (let x = x0; x < x0 + geom.cellWidth; x++) {
      const [r, g, b] = img.pixel(x, y);
      parts.push(r, g, b);
    }
  }
  return parts.join(',');
}

function countDifferentFrom(
  img: DecodedPng,
  col: number,
  row: number,
  geom: ReturnType<typeof measureGrid>,
  bg: [number, number, number],
): number {
  const x0 = geom.padX + col * geom.cellWidth;
  const y0 = geom.padY + row * geom.cellHeight;
  let count = 0;
  for (let y = y0; y < y0 + geom.cellHeight; y++) {
    for (let x = x0; x < x0 + geom.cellWidth; x++) {
      const [r, g, b] = img.pixel(x, y);
      if (Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 30) count++;
    }
  }
  return count;
}

describe('renderOperatorScreen', () => {
  it('renders a valid non-empty PNG whose pixel dimensions scale with cols and rows', async () => {
    const small = await renderOperatorScreen({ cells: 'Choose a theme.\n> Dark\n  Light\n', cols: 40, rows: 12, secrets: [] });
    const large = await renderOperatorScreen({ cells: 'Choose a theme.\n> Dark\n  Light\n', cols: 80, rows: 24, secrets: [] });

    expect(pictureType(small.png)).toBe('image/png');
    expect(small.png.byteLength).toBeGreaterThan(200);
    expect(small.text).toBe('Choose a theme.\n> Dark\n  Light');

    const decodedSmall = decodePng(small.png);
    const decodedLarge = decodePng(large.png);
    expect(decodedSmall.width).toBe(small.width);
    expect(decodedSmall.height).toBe(small.height);
    expect(decodedLarge.width).toBe(large.width);
    expect(decodedLarge.height).toBe(large.height);
    expect(large.width).toBeGreaterThan(small.width);
    expect(large.height).toBeGreaterThan(small.height);
  });

  it('draws distinct Latin and Cyrillic glyphs rather than blank space or missing-glyph boxes', async () => {
    const geom = measureGrid();
    const out = await renderOperatorScreen({
      cells: 'AZ09\nЖШфЁ№',
      cols: 12,
      rows: 3,
      secrets: [],
    });
    expect(out.text).toBe('AZ09\nЖШфЁ№');

    const img = decodePng(out.png);
    const [bgR, bgG, bgB] = img.pixel(2, 2);

    /* Row 2 is empty and stays on the background color. */
    for (let col = 0; col < 5; col++) {
      expect(countDifferentFrom(img, col, 2, geom, [bgR, bgG, bgB])).toBe(0);
    }

    /* Every Latin and Cyrillic glyph cell paints visible foreground ink. */
    for (let col = 0; col < 4; col++) {
      expect(countDifferentFrom(img, col, 0, geom, [bgR, bgG, bgB])).toBeGreaterThan(8);
    }
    for (let col = 0; col < 5; col++) {
      expect(countDifferentFrom(img, col, 1, geom, [bgR, bgG, bgB])).toBeGreaterThan(8);
    }

    /* Missing glyphs all share one .notdef box; distinct Cyrillic letters must produce distinct bitmaps. */
    const cyrSigs = new Set([0, 1, 2, 3, 4].map(col => cellSignature(img, col, 1, geom)));
    expect(cyrSigs.size).toBe(5);
    const missing = decodePng((await renderOperatorScreen({ cells: '\u0378', cols: 4, rows: 1, secrets: [] })).png);
    const missingSig = cellSignature(missing, 0, 0, geom);
    for (let col = 0; col < 5; col++) {
      expect(cellSignature(img, col, 1, geom)).not.toBe(missingSig);
    }
  });

  it('renders inverse video (SGR 7 / 27), bold (SGR 1 / 22), and ANSI / 256 / truecolor SGR styles in pixels', async () => {
    const geom = measureGrid();
    const out = await renderOperatorScreen({
      cells: [
        ' A ',
        '\x1b[7m A \x1b[27m ',
        '\x1b[31m█\x1b[0m\x1b[42m \x1b[0m\x1b[38;5;208m█\x1b[0m\x1b[48;2;20;90;210m \x1b[0m\x1b[48:2::200:40:160m \x1b[0m',
        'M\x1b[1mM\x1b[22mM',
      ].join('\n'),
      cols: 12,
      rows: 4,
      secrets: [],
    });

    const img = decodePng(out.png);
    const [bgR, bgG, bgB] = img.pixel(2, 2);

    /* Normal space at (0, 0) uses terminal background; inverse space at (0, 1) swaps to light foreground fill. */
    const normalSpace = img.pixel(geom.padX + Math.floor(geom.cellWidth / 2), geom.padY + Math.floor(geom.cellHeight / 2));
    const inverseSpace = img.pixel(geom.padX + Math.floor(geom.cellWidth / 2), geom.padY + geom.cellHeight + Math.floor(geom.cellHeight / 2));
    const afterInverseReset = img.pixel(geom.padX + 3 * geom.cellWidth + Math.floor(geom.cellWidth / 2), geom.padY + geom.cellHeight + Math.floor(geom.cellHeight / 2));

    expect(normalSpace.slice(0, 3)).toEqual([bgR, bgG, bgB]);
    expect(inverseSpace[0]).toBeGreaterThan(bgR + 140);
    expect(inverseSpace[1]).toBeGreaterThan(bgG + 140);
    expect(inverseSpace[2]).toBeGreaterThan(bgB + 140);
    expect(afterInverseReset.slice(0, 3)).toEqual([bgR, bgG, bgB]);

    /* Inverse glyph cell (1, 1) draws dark glyph strokes inside the light background. */
    expect(countDifferentFrom(img, 1, 1, geom, [inverseSpace[0], inverseSpace[1], inverseSpace[2]])).toBeGreaterThan(8);

    /* Red fg block (0, 2), green bg space (1, 2), 256-color orange block (2, 2), RGB blue bg (3, 2), colon RGB magenta bg (4, 2). */
    const redBlock = img.pixel(geom.padX + Math.floor(geom.cellWidth / 2), geom.padY + 2 * geom.cellHeight + Math.floor(geom.cellHeight / 2));
    expect(redBlock[0]).toBeGreaterThan(redBlock[1] + 80);
    expect(redBlock[0]).toBeGreaterThan(redBlock[2] + 80);

    const greenBg = img.pixel(geom.padX + geom.cellWidth + 2, geom.padY + 2 * geom.cellHeight + 2);
    expect(greenBg[1]).toBeGreaterThan(greenBg[0] + 50);

    const orangeBlock = img.pixel(geom.padX + 2 * geom.cellWidth + Math.floor(geom.cellWidth / 2), geom.padY + 2 * geom.cellHeight + Math.floor(geom.cellHeight / 2));
    expect(orangeBlock[0]).toBeGreaterThan(180);
    expect(orangeBlock[1]).toBeGreaterThan(70);
    expect(orangeBlock[2]).toBeLessThan(60);

    const rgbBlueBg = img.pixel(geom.padX + 3 * geom.cellWidth + 2, geom.padY + 2 * geom.cellHeight + 2);
    expect(rgbBlueBg.slice(0, 3)).toEqual([20, 90, 210]);

    const colonRgbBg = img.pixel(geom.padX + 4 * geom.cellWidth + 2, geom.padY + 2 * geom.cellHeight + 2);
    expect(colonRgbBg.slice(0, 3)).toEqual([200, 40, 160]);

    /* Bold M at (1, 3) differs from regular M at (0, 3) and SGR 22 restores regular M at (2, 3). */
    expect(cellSignature(img, 1, 3, geom)).not.toBe(cellSignature(img, 0, 3, geom));
    expect(cellSignature(img, 2, 3, geom)).toBe(cellSignature(img, 0, 3, geom));

    /* Bright ANSI colors, 256-color <16 / >255 / grayscale, underline (4/24), dim (2), default fg/bg (39/49), and empty reset (\x1b[m). */
    const extra = renderOperatorScreenSvg({
      cells: '\x1b[91;104;4;2mX\x1b[24;39;49mY\x1b[38;5;12;48;5;240mZ\x1b[38:5:9;38;5;300;38;9;48:2:10:20:30;48:9:1mW\x1b[38;2;300;0;10mQ\x1b[mR\tT',
      cols: 20,
      rows: 2,
      secrets: [],
    });
    expect(extra.svg).toContain('fill-opacity="0.65"');
    expect(extra.svg).toContain('height="1"');
    expect(extra.svg).toContain('#ff000a');
    expect(extra.svg).toContain('#0a141e');
    expect(extra.text).toBe('XYZWQR  T');
  });

  it('re-masks whole secrets, encoded forms, NFD forms, line-wrapped secrets, and ANSI-split secrets', async () => {
    const secret = 'sk-live-secret-998877';
    const b64 = Buffer.from(secret).toString('base64');
    const shortSecret = 'pin731';
    const cyrSecret = 'пароль-ёжик-42';
    const cyrSecretNfd = cyrSecret.normalize('NFD');
    const cells = [
      `Plain: ${secret} and ${secret}`,
      `Split: sk-\x1b[31mlive\x1b[1m-secret-\x1b[7m998877\x1b[0m end`,
      `PerChar: s\x1b[32mk\x1b[33m-\x1b[34ml\x1b[35mi\x1b[36mv\x1b[31me-secret-998877\x1b[0m`,
      `Encoded: ${b64} and ${shortSecret}`,
      `Wrapped: sk-live-sec\nret-998877 tail`,
      `Decomposed: ${cyrSecretNfd}`,
      '\x1b[32mKeep green label\x1b[0m',
    ].join('\n');

    const pre = renderOperatorScreenSvg({ cells, cols: 60, rows: 10, secrets: [secret, shortSecret, cyrSecret, ''] });
    const out = await renderOperatorScreen({ cells, cols: 60, rows: 10, secrets: [secret, shortSecret, cyrSecret, ''] });

    for (const leaked of [secret, 'live-secret', '998877', 'ret-998877', b64, b64.replace(/=+$/, ''), shortSecret, 'ёжик', 'е\u0308жик']) {
      expect(out.text).not.toContain(leaked);
      expect(pre.svg).not.toContain(leaked);
    }

    expect(out.text).toBe([
      'Plain: [hidden] and [hidden]',
      'Split: [hidden] end',
      'PerChar: [hidden]',
      'Encoded: [hidden] and [hidden]',
      'Wrapped: [hidden] tail',
      'Decomposed: [hidden]',
      'Keep green label',
    ].join('\n'));

    /* The rendered PNG of a masked split secret matches a clean [hidden] line byte-for-byte. */
    const fromSplit = await renderOperatorScreen({
      cells: 'Key: sk-\x1b[31mlive\x1b[0m-secret-998877',
      cols: 40,
      rows: 3,
      secrets: [secret],
    });
    const fromLiteral = await renderOperatorScreen({
      cells: 'Key: [hidden]',
      cols: 40,
      rows: 3,
      secrets: [],
    });
    expect(fromSplit.png.equals(fromLiteral.png)).toBe(true);
  });

  it('strips OSC links, OSC 52 clipboard payloads, non-SGR CSI/DCS sequences, and terminal control characters', async () => {
    const cells = [
      '\x1b]0;Window Title\x07\x1b]52;c;c2VjcmV0LWNsaXBib2FyZA==\x07Header',
      '\x1b]8;;https://evil.example/phish?x=1\x07Visible link\x1b]8;;\x07',
      '\x1b]52;c;dHdv\x1b\\\x1bPtmux;\x1b\x1b]8;;https://nested.invalid\x07\x1b\\\x1b[2J\x1b[H\x1b[?25lMenu\x00\x07\x08 item',
      'Tail\x1b]8;;https://unterminated.invalid/leak',
    ].join('\r\n');

    const pre = renderOperatorScreenSvg({ cells, cols: 50, rows: 6, secrets: [] });
    const out = await renderOperatorScreen({ cells, cols: 50, rows: 6, secrets: [] });

    expect(out.text).toBe('Header\nVisible link\nMenu item\nTail');
    for (const forbidden of ['Window Title', 'c2VjcmV0', 'evil.example', 'nested.invalid', 'unterminated.invalid', '\x1b']) {
      expect(out.text).not.toContain(forbidden);
      expect(pre.svg).not.toContain(forbidden);
    }
  });

  it('escapes screen markup (<, &, >, quotes, ]]>) as literal text without breaking or injecting SVG', async () => {
    const tricky = '<svg onload="alert(1)"> & </text><rect id="injected" width="9999"/> ]]> "dq" \'sq\' \uffff';
    const pre = renderOperatorScreenSvg({ cells: tricky, cols: 100, rows: 4, secrets: [] });
    const out = await renderOperatorScreen({ cells: tricky, cols: 100, rows: 4, secrets: [] });

    expect(out.text).toBe('<svg onload="alert(1)"> & </text><rect id="injected" width="9999"/> ]]> "dq" \'sq\' \ufffd');
    expect(pre.svg).not.toContain('id="injected"');
    expect(pre.svg).not.toContain('onload="alert(1)"');
    expect(pre.svg).toContain('&lt;');
    expect(pre.svg).toContain('&amp;');
    expect(pre.svg).toContain('&gt;');
    expect(pictureType(out.png)).toBe('image/png');
  });

  it('wraps joined lines across pane columns so soft-wrapped tmux lines stay visible on screen', async () => {
    const out = await renderOperatorScreen({
      cells: 'ABCDEFGHIJ12345',
      cols: 10,
      rows: 3,
      secrets: [],
    });
    const geom = measureGrid();
    const img = decodePng(out.png);
    const [bgR, bgG, bgB] = img.pixel(2, 2);
    /* Characters past column 10 wrap onto row 1 instead of being clipped off the right edge. */
    expect(countDifferentFrom(img, 0, 1, geom, [bgR, bgG, bgB])).toBeGreaterThan(8);
  });

  it('accepts 64 KiB of cells and rejects oversize cells, invalid dimensions, or PNGs above 1 MiB', async () => {
    /* Exact 65536-byte boundary passes. */
    const exact64k = `${'a'.repeat(79)}\n`.repeat(819) + 'b'.repeat(16);
    expect(Buffer.byteLength(exact64k, 'utf8')).toBe(65_536);
    const ok = await renderOperatorScreen({ cells: exact64k, cols: 80, rows: 24, secrets: [] });
    expect(pictureType(ok.png)).toBe('image/png');

    /* 65537 bytes (ASCII and multi-byte UTF-8 Cyrillic) fails. */
    await expect(renderOperatorScreen({ cells: `${exact64k}x`, cols: 80, rows: 24, secrets: [] })).rejects.toThrow(/64 KiB/i);
    const cyrOver = 'Ж'.repeat(32_769);
    expect(Buffer.byteLength(cyrOver, 'utf8')).toBe(65_538);
    await expect(renderOperatorScreen({ cells: cyrOver, cols: 80, rows: 24, secrets: [] })).rejects.toThrow(/64 KiB/i);

    /* Invalid cols / rows fail. */
    for (const [cols, rows] of [[0, 24], [-1, 24], [513, 24], [80, 0], [80, 257], [1.5, 24], [80, Number.NaN]] as const) {
      await expect(renderOperatorScreen({ cells: 'ok', cols, rows, secrets: [] })).rejects.toThrow();
    }

    /* Dense colorful 512x256 pane under 64 KiB whose rasterized PNG exceeds 1 MiB throws instead of clipping. */
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789#@%&*+=?~^/\\|<>[]{}()';
    const noisyRows: string[] = [];
    for (let r = 0; r < 140; r++) {
      let line = '';
      for (let c = 0; c < 180; c++) {
        line += alphabet[((r * 131 + c * 97 + ((r * c) % 29)) >>> 0) % alphabet.length]!;
      }
      noisyRows.push(line);
    }
    const noisy = noisyRows.join('\n');
    expect(Buffer.byteLength(noisy, 'utf8')).toBeLessThanOrEqual(65_536);
    const pane = { cells: noisy, cols: 512, rows: 256, secrets: [] };
    const whole = renderOperatorScreenSvg(pane).svg;
    /* How big a PNG a pane makes is resvg's own business, and laying out tens of thousands of glyphs only measures the machine:
       the drawing hands back a PNG of the size each side of the limit. One byte above 1 MiB throws; exactly 1 MiB goes. Either
       way the drawing got the whole pane, not a clipped one. */
    const drawn: string[] = [];
    const sized = (bytes: number) => (svg: string) => (drawn.push(svg), Promise.resolve(new Uint8Array(bytes)));
    await expect(renderOperatorScreen(pane, sized(1_048_577))).rejects.toThrow(/1 MiB/i);
    expect((await renderOperatorScreen(pane, sized(1_048_576))).png.byteLength).toBe(1_048_576);
    expect(drawn).toEqual([whole, whole]);
  });

  it('draws in its own thread the very PNG resvg draws of the same SVG', async () => {
    const input = { cells: '\x1b[1mBold\x1b[0m and \x1b[31mred\x1b[0m, Привет\n> 1. Yes', cols: 30, rows: 3, secrets: [] };
    const here = Buffer.from(new Resvg(renderOperatorScreenSvg(input).svg, PAINT_OPTIONS).render().asPng());
    expect((await renderOperatorScreen(input)).png.equals(here)).toBe(true);
  });

  it('does not join short secrets across a hard line break', async () => {
    const out = renderOperatorScreenSvg({ cells: 'go to\npage', cols: 20, rows: 3, secrets: ['top'] });
    expect(out.text).toBe('go to\npage');
  });
});
