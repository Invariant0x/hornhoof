import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adapterFor } from '../src/providers/index.js';
import { installAgy } from '../src/providers/antigravity.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

let dir: string;
let home: string;
let project: string;
let tools: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hh-untrusted-npm-'));
  home = join(dir, 'home');
  project = join(dir, 'project');
  tools = join(dir, 'tools');
  mkdirSync(home);
  mkdirSync(project);
  writeFileSync(join(home, '.npmrc'), 'registry=https://home.invalid/\n@openai:registry=https://home.invalid/\n');
  writeFileSync(join(project, '.npmrc'), 'registry=https://project.invalid/\n@anthropic-ai:registry=https://project.invalid/\n');
  writeFileSync(join(project, 'package.json'), '{"name":"untrusted-project"}');
  vi.stubEnv('HOME', home);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  rmSync(dir, { recursive: true, force: true });
});

describe('node-owned npm installations', () => {
  it.each(['claude', 'codex', 'kimi'] as const)('installs %s without agent home or project settings', async provider => {
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let installerHome = '';
    vi.mocked(spawn).mockImplementation((bin, args, options) => {
      expect(bin).toBe('npm');
      expect(args).toContain('-g');
      expect(args).toContain('--prefix');
      const env = options!.env!;
      installerHome = env.HOME!;
      expect(installerHome).not.toBe(home);
      expect(isAbsolute(installerHome)).toBe(true);
      expect(options!.cwd).toBe(installerHome);
      expect(statSync(installerHome).mode & 0o777).toBe(0o700);
      expect(readFileSync(env.NPM_CONFIG_USERCONFIG!, 'utf8')).toBe('');
      expect(readFileSync(env.NPM_CONFIG_GLOBALCONFIG!, 'utf8')).toBe('');
      /* npm reads its settings from the env, the folder it runs in and the user and global files: we give it only our own. */
      expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org/');
      expect(env.NPM_CONFIG_CACHE).toBe(join(installerHome, 'cache'));
      expect(env.NPM_CONFIG_WORKSPACES).toBe('false');
      expect(Object.keys(env).filter(key => /^npm_config_/i.test(key)).sort()).toEqual(['NPM_CONFIG_CACHE', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_WORKSPACES']);
      expect(readFileSync(join(options!.cwd as string, 'package.json'), 'utf8')).toBe('{}');
      expect(readFileSync(join(options!.cwd as string, '.npmrc'), 'utf8')).toBe('');
      return real.spawn(process.execPath, ['-e', ''], options);
    });
    await adapterFor(provider, { tools, home }).install();
    expect(existsSync(installerHome)).toBe(false);
  });

  it('discards inherited npm, runtime and script overrides before starting npm', async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0);
    for (const [name, value] of Object.entries({
      npm_config_registry: 'https://lower.invalid/',
      NPM_CONFIG_REGISTRY: 'https://upper.invalid/',
      npm_config_userconfig: join(home, '.npmrc'),
      NPM_CONFIG_GLOBALCONFIG: join(project, '.npmrc'),
      NpM_CoNfIg_Script_Shell: '/untrusted/shell',
      NODE_OPTIONS: '--no-warnings', NODE_PATH: project,
      BASH_ENV: join(home, '.bashrc'), ENV: join(home, '.profile'),
      LD_PRELOAD: '/untrusted/preload.so', TAR_OPTIONS: '--version',
      HTTP_PROXY: 'http://proxy.invalid', PLAYWRIGHT_DOWNLOAD_HOST: 'https://download.invalid',
      PATH: '/untrusted/bin', TMPDIR: home,
    })) vi.stubEnv(name, value);
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let installerHome = '';
    vi.mocked(spawn).mockImplementation((_bin, _args, options) => {
      const env = options!.env!;
      installerHome = env.HOME!;
      expect(env.PATH).toBe('/usr/local/bin:/usr/bin:/bin');
      expect(env.TMPDIR).toBe(installerHome);
      expect(installerHome.startsWith('/tmp/hh-install-')).toBe(true);
      expect(env.npm_config_registry).toBeUndefined();
      expect(env.NPM_CONFIG_REGISTRY).toBe('https://registry.npmjs.org/');
      expect(env.npm_config_userconfig).toBeUndefined();
      for (const key of ['NpM_CoNfIg_Script_Shell', 'NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'TAR_OPTIONS', 'HTTP_PROXY', 'PLAYWRIGHT_DOWNLOAD_HOST']) {
        expect(env[key], key).toBeUndefined();
      }
      expect(Object.keys(env).filter(key => /^npm_config_/i.test(key)).sort()).toEqual(['NPM_CONFIG_CACHE', 'NPM_CONFIG_GLOBALCONFIG', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_WORKSPACES']);
      expect(readFileSync(env.NPM_CONFIG_USERCONFIG!, 'utf8')).toBe('');
      expect(readFileSync(env.NPM_CONFIG_GLOBALCONFIG!, 'utf8')).toBe('');
      return real.spawn(process.execPath, ['-e', 'process.exit(1)'], options);
    });
    await expect(adapterFor('codex', { tools, home }).install()).rejects.toThrow('npm ended with code 1');
    expect(existsSync(installerHome)).toBe(false);
  });

  it.each([0, 1])('extracts Antigravity without inherited options and cleans up after exit %i', async code => {
    vi.stubEnv('TAR_OPTIONS', '--version');
    vi.stubEnv('npm_config_registry', 'https://lower.invalid/');
    const archive = Buffer.from('downloaded archive');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://release.invalid/cli.tar.gz', sha512: createHash('sha512').update(archive).digest('hex') })))
      .mockResolvedValueOnce(new Response(archive));
    const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let installerHome = '';
    vi.mocked(spawn).mockImplementation((bin, args, options) => {
      expect(bin).toBe('tar');
      expect(options!.env!.TAR_OPTIONS).toBeUndefined();
      expect(options!.env!.npm_config_registry).toBeUndefined();
      installerHome = options!.env!.HOME!;
      expect(installerHome).not.toBe(home);
      expect(options!.cwd).toBe(installerHome);
      writeFileSync(join(args![args!.indexOf('-C') + 1]!, 'antigravity'), '#!/bin/sh\n');
      return real.spawn(process.execPath, ['-e', `process.exit(${code})`], options);
    });
    if (code === 0) {
      await installAgy(tools);
      expect(readFileSync(join(tools, 'bin', 'agy'), 'utf8')).toBe('#!/bin/sh\n');
    } else {
      await expect(installAgy(tools)).rejects.toThrow('Antigravity CLI could not be taken out of its archive');
      expect(existsSync(join(tools, 'bin', 'agy'))).toBe(false);
    }
    expect(existsSync(installerHome)).toBe(false);
  });

  it('installs a verified raw Antigravity binary without invoking an installer subprocess', async () => {
    const binary = Buffer.from('#!/bin/sh\n');
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ url: 'https://release.invalid/antigravity', sha512: createHash('sha512').update(binary).digest('hex') })))
      .mockResolvedValueOnce(new Response(binary));
    await installAgy(tools);
    expect(readFileSync(join(tools, 'bin', 'agy'))).toEqual(binary);
    expect(statSync(join(tools, 'bin', 'agy')).mode & 0o777).toBe(0o755);
    expect(spawn).not.toHaveBeenCalled();
  });
});
