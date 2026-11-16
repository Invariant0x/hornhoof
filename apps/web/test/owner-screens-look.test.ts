import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { fieldsetFrameOffences, fieldsetHeadingOffences, focusRing } from '../e2e/owner-screens-look';
import { checkSizes } from '../e2e/owner-screens-sizes';

function locatorOf(root: Element): Locator {
  return {
    evaluate: <R, A>(fn: (el: Element, arg: A) => R, arg?: A) => Promise.resolve(fn(root, arg as A)),
  } as unknown as Locator;
}

const pageStub = {
  evaluate: <R>(fn: () => R) => Promise.resolve(fn()),
} as unknown as Page;

function setBox(el: Element, rect: { left: number; top: number; width: number; height: number }): void {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  el.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, right, bottom, toJSON: () => rect });
}

describe('owner screen look and size checks', () => {
  it('accepts borderless field-group fieldsets on parent edges with 4px under legend and flags browser frames or bad gaps', async () => {
    const root = document.createElement('section');
    setBox(root, { left: 10, top: 0, width: 320, height: 240 });

    const hidden = document.createElement('fieldset');
    hidden.innerHTML = '<legend>Hidden</legend><div><select></select></div>';
    setBox(hidden, { left: 10, top: 0, width: 0, height: 0 });

    const clean = document.createElement('fieldset');
    clean.style.borderTopWidth = '0px';
    clean.style.paddingInlineStart = '0px';
    clean.style.paddingInlineEnd = '0px';
    clean.innerHTML = '<legend>Messages</legend><div class="field-group-body"><select></select></div>';
    setBox(clean, { left: 10, top: 20, width: 320, height: 68 });
    setBox(clean.querySelector('legend')!, { left: 10, top: 20, width: 80, height: 20 });
    setBox(clean.querySelector('select')!, { left: 10, top: 44, width: 320, height: 44 });

    root.append(hidden, clean);
    expect(await fieldsetFrameOffences(locatorOf(root))).toEqual([]);
    expect(await fieldsetHeadingOffences(locatorOf(root))).toEqual([]);

    const framed = document.createElement('fieldset');
    framed.style.borderTopWidth = '2px';
    framed.style.paddingInlineStart = '12px';
    framed.style.paddingInlineEnd = '12px';
    framed.innerHTML = '<legend>Prices</legend><div class="field-group-body"><select></select></div>';
    setBox(framed, { left: 18, top: 100, width: 304, height: 80 });
    setBox(framed.querySelector('legend')!, { left: 24, top: 100, width: 60, height: 20 });
    setBox(framed.querySelector('select')!, { left: 24, top: 132, width: 280, height: 44 });

    const empty = document.createElement('fieldset');
    empty.style.borderTopWidth = '0px';
    empty.style.paddingInlineStart = '0px';
    empty.style.paddingInlineEnd = '0px';
    empty.innerHTML = '<legend>Empty</legend>';
    setBox(empty, { left: 10, top: 190, width: 320, height: 24 });
    setBox(empty.querySelector('legend')!, { left: 10, top: 190, width: 60, height: 20 });

    root.append(framed, empty);
    expect(await fieldsetFrameOffences(locatorOf(root))).toEqual([
      '6: fieldset "Prices" keeps the browser\'s frame',
      '6: fieldset "Prices" leaves its parent\'s edge',
    ]);
    expect(await fieldsetHeadingOffences(locatorOf(root))).toEqual([
      '6: fieldset "Prices" has 12px under its heading',
      '6: fieldset "Empty" has NaNpx under its heading',
    ]);
  });

  it('requires a 2px solid cyan focus ring with 2px offset on the focused control', async () => {
    document.body.innerHTML = '';
    document.documentElement.style.setProperty('--cyan-ink', 'rgb(0, 212, 232)');
    expect(await focusRing(pageStub)).toBe('nothing has focus');

    const btn = document.createElement('button');
    const probe = document.body.appendChild(document.createElement('span'));
    probe.style.color = 'var(--cyan-ink)';
    const cyan = getComputedStyle(probe).color;
    probe.remove();
    btn.style.outlineStyle = 'solid';
    btn.style.outlineWidth = '2px';
    btn.style.outlineOffset = '2px';
    btn.style.outlineColor = cyan;
    document.body.append(btn);
    btn.focus();
    expect(await focusRing(pageStub)).toBe('ring');

    btn.style.outlineOffset = '0px';
    expect(await focusRing(pageStub)).toBe(`button has the outline solid 2px 0px ${cyan}`);
  });

  it('checks measured browser piece sizes within 1px and throws when spread exceeds 1px', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hh-sizes-'));
    try {
      writeFileSync(
        join(dir, 'sizes.json'),
        JSON.stringify([
          { browser: 'chromium', screen: 'machines', look: 'en-1440', sizes: { 'sortHeader height': 44, 'rowButton height': 44 } },
          { browser: 'firefox', screen: 'machines', look: 'en-1440', sizes: { 'sortHeader height': 44, 'rowButton height': 45 } },
        ]),
      );
      expect(() => checkSizes(dir)).not.toThrow();

      writeFileSync(
        join(dir, 'sizes.json'),
        JSON.stringify([
          { browser: 'chromium', screen: 'machines', look: 'en-1440', sizes: { 'sortHeader height': 44 } },
          { browser: 'webkit', screen: 'machines', look: 'en-1440', sizes: { 'sortHeader height': 46 } },
        ]),
      );
      expect(() => checkSizes(dir)).toThrow(/sortHeader height: chromium 44, webkit 46/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
