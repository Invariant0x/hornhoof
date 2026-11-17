import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { KEYBOARD, keyboardApk } from '../src/phones/keyboard.js';

it('takes the keyboard app only as its author built it, and fetches it once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phone-keyboard-'));
  const asked: string[] = [];
  const answer = (bytes: string) => async (url: string | URL | Request) => { asked.push(String(url)); return new Response(bytes); };
  await expect(keyboardApk(dir, answer('a changed build'))()).rejects.toThrow('phone_keyboard_unavailable');
  const build = 'the author build';
  const apk = keyboardApk(dir, answer(build), createHash('sha256').update(build).digest('hex'));
  const path = await apk();
  await apk();
  expect(readFileSync(path, 'utf8')).toBe(build);
  expect(asked).toEqual([KEYBOARD.url, KEYBOARD.url]);
});
