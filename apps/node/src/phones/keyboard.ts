import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/* ADBKeyBoard (github.com/senzhk/ADBKeyBoard, GPL-2.0), a keyboard app that types any text adb sends it. The node takes the
   author's own release and checks it is that build, so every phone gets exactly this one. */
export const KEYBOARD = {
  url: 'https://github.com/senzhk/ADBKeyBoard/releases/download/v2.5-dev/keyboardservice-debug.apk',
  sha256: '41a8a0996d7397a2390d1ca16a75cb66c4a7bdaa89cf4e63600a4d3fb346fbbb',
};

/* The keyboard app's path in dir, fetched the first time a phone needs it. */
export function keyboardApk(dir: string, get: typeof fetch = fetch, sha256 = KEYBOARD.sha256): () => Promise<string> {
  const path = join(dir, 'adbkeyboard.apk');
  const built = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex') === sha256;
  let pending: Promise<string> | null = null;
  return () => (pending ??= (async () => {
    if (built(await readFile(path).catch(() => Buffer.alloc(0)))) return path;
    const response = await get(KEYBOARD.url);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok || !built(bytes)) throw new Error('phone_keyboard_unavailable');
    await writeFile(`${path}.part`, bytes);
    await rename(`${path}.part`, path);
    return path;
  })().catch((error: unknown) => { pending = null; throw error; }));
}
