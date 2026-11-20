import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

/* Note #59: a test fails only on a wrong result, never on time. A slow machine makes a correct browser test slow, not
   wrong, and a test that truly hangs is ended by the limit of the run it is part of (#1663). So no browser test of the web
   app has a time limit of its own: every Playwright config, the default one and each under e2e, sets 0, which Playwright
   reads as none, for a test, an expectation, an action and a navigation, and no spec or helper sets another. Without it a
   config gets Playwright's own 30 s for a test and 5 s for an expectation, as the default config did until #1663. */
/* Vite, which loads the configs here, turns a config's `new URL(path, import.meta.url)` into a web address. The folder it
   names is no limit, so here it is read as a path. */
vi.mock('node:url', async original => {
  const url = await original<typeof import('node:url')>();
  return { ...url, fileURLToPath: (href: string | URL) => new url.URL(String(href)).pathname };
});
type Limits = Pick<PlaywrightTestConfig, 'timeout' | 'expect' | 'use'>;
/* The files are listed when the test runs, not by import.meta.glob: Vitest keeps a transformed test file in its module
   cache, list and all, so a config added later would go unseen until this file changed. */
const WEB = resolve(__dirname, '..');
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => (entry.isDirectory() ? (entry.name === 'results' ? [] : filesUnder(join(dir, entry.name))) : [join(dir, entry.name)]));
const E2E = filesUnder(join(WEB, 'e2e')).filter(path => path.endsWith('.ts'));
const CONFIGS = ['playwright.config.ts', ...E2E.filter(path => path.endsWith('.config.ts')).map(path => relative(WEB, path))];
const SOURCES = E2E.filter(path => !path.endsWith('.config.ts'));

/* The limits a config or a project gives a test, an expectation, an action and a navigation. Playwright gives none to an
   action or a navigation it says nothing of, but 30 s to a test and 5 s to an expectation. */
const limitsOf = ({ timeout, expect: expectation, use }: Limits) => ({ test: timeout, expect: expectation?.timeout, action: use?.actionTimeout, navigation: use?.navigationTimeout });
const NO_LIMITS = { test: 0, expect: 0, action: 0, navigation: 0 };

/* A line of a spec or helper that sets a time limit other than 0: test.setTimeout(N), or any timeout option, as
   `timeout: N`, `actionTimeout: N` or `navigationTimeout: N`. */
const LIMIT = /\b(?:test|it)\.setTimeout\((?!\s*0\s*\))|[Tt]imeout:(?!\s*0\b)/;

describe('the time limits of the web app’s browser tests', () => {
  it('are looked for in every config and every spec', () => {
    expect(CONFIGS.filter(path => path.startsWith('e2e/')).length).toBeGreaterThan(30);
    expect(SOURCES.filter(path => path.endsWith('.spec.ts')).length).toBeGreaterThan(100);
  });

  it.each(CONFIGS)('are none in %s, for a test, an expectation, an action and a navigation', async path => {
    const config = ((await import(/* @vite-ignore */ join(WEB, path))) as { default: PlaywrightTestConfig }).default;
    const own = limitsOf(config);
    expect({ ...own, action: own.action ?? 0, navigation: own.navigation ?? 0 }).toEqual(NO_LIMITS);
    /* A project keeps the config's limits, or says 0 itself. */
    for (const project of config.projects ?? []) expect({ ...NO_LIMITS, ...Object.fromEntries(Object.entries(limitsOf(project)).filter(([, ms]) => ms !== undefined)) }, `project ${project.name}`).toEqual(NO_LIMITS);
  });

  it('are set by no spec or helper', () => {
    const limited = SOURCES.flatMap(path => readFileSync(path, 'utf8').split('\n').flatMap((line, i) => (LIMIT.test(line) ? [`${relative(WEB, path)}:${i + 1}: ${line.trim()}`] : [])));
    expect(limited).toEqual([]);
  });
});
