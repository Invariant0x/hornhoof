import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Each caller owns its directories; parallel files do not share mutable cleanup state. */
export function nativeFiles(prefix: string): { file(): string; clean(): void } {
  const dirs: string[] = [];
  return {
    file(): string {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      dirs.push(dir);
      return join(dir, 'wire.jsonl');
    },
    clean(): void {
      for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    },
  };
}
