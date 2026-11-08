import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const script = join(__dirname, '..', 'browser-packages.cjs');

function bundleWith(platform: Record<string, string[]>): string {
  const dir = mkdtempSync(join(tmpdir(), 'browser-packages-'));
  const file = join(dir, 'coreBundle.js');
  writeFileSync(file, [
    '// packages/playwright-core/src/server/registry/nativeDeps.ts',
    'var deps;',
    `var init_nativeDeps = __esm({ "nativeDeps"() { deps = { "debian12-x64": ${JSON.stringify(platform)} }; } });`,
    '// packages/playwright-core/src/server/registry/index.ts',
    '',
  ].join('\n'));
  return file;
}

describe('the Debian packages the node image installs for browsers', () => {
  it('cover Chromium, Firefox and WebKit, each package once', () => {
    const bundle = bundleWith({ tools: ['xvfb'], chromium: ['libnss3', 'libgbm1'], firefox: ['libgtk-3-0', 'libnss3'], webkit: ['libwoff1', 'libgbm1'] });
    const printed = execFileSync('node', [script, bundle, 'debian12-x64'], { encoding: 'utf8' }).trim().split(' ');
    expect(printed.sort()).toEqual(['libgbm1', 'libgtk-3-0', 'libnss3', 'libwoff1', 'xvfb']);
  });

  it('stops when a browser has no packages for the platform', () => {
    const bundle = bundleWith({ tools: ['xvfb'], chromium: ['libnss3'], firefox: ['libgtk-3-0'] });
    expect(() => execFileSync('node', [script, bundle, 'debian12-x64'], { stdio: 'pipe' })).toThrow();
  });
});
