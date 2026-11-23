import { afterEach, describe, expect, it } from 'vitest';
import { applyKit, type Kit } from '../src/skins/kit';

/* A theme's painted interface parts, from its ui/kit.json as #1960's store keeps it, put on the page as the CSS variables
   kit.css draws from (THEME-UI-KIT.md, section 3). The pictures come only from the theme's files on the server. */

const page = document.documentElement;
const BASE = '/api/themes/files/sand-test/1.0.0/';
const kitVariables = () => [...page.style].filter(name => name.startsWith('--kit-')).sort();

const KIT: Kit = {
  slots: {
    dialog: { file: 'dialog.frame@2x.webp', slice: '34', width: '17px' },
    btn: { file: 'btn@2x.png', slice: '10 fill', width: '5px', outset: '1px' },
    panel: { file: 'panel.fill@2x.webp', size: '128px 128px' },
    tab: { file: 'tab.svg', slice: '12 fill', width: '6.5px' },
  },
  colors: { 'tab-ink': '#502704' },
};

afterEach(() => applyKit(page, null, BASE));

describe('applyKit', () => {
  it("puts each slot's picture, slice, width, outset and size and each kit colour on the page, and marks it", () => {
    applyKit(page, KIT, BASE);
    expect(page.dataset.kit).toBe('on');
    expect(page.style.getPropertyValue('--kit-dialog')).toBe(`url("${BASE}ui/kit/dialog.frame%402x.webp")`);
    expect(page.style.getPropertyValue('--kit-dialog-slice')).toBe('34');
    expect(page.style.getPropertyValue('--kit-dialog-width')).toBe('17px');
    expect(page.style.getPropertyValue('--kit-btn-slice')).toBe('10 fill');
    expect(page.style.getPropertyValue('--kit-btn-outset')).toBe('1px');
    expect(page.style.getPropertyValue('--kit-panel-size')).toBe('128px 128px');
    expect(page.style.getPropertyValue('--kit-tab')).toBe(`url("${BASE}ui/kit/tab.svg")`);
    expect(page.style.getPropertyValue('--kit-tab-width')).toBe('6.5px');
    expect(page.style.getPropertyValue('--kit-c-tab-ink')).toBe('#502704');
  });

  /* A plate whose painted middle is its face: the element's own fill steps aside. */
  it('clears the fill of an element whose slot paints its middle, and only then', () => {
    applyKit(page, KIT, BASE);
    expect(page.style.getPropertyValue('--kit-btn-bg')).toBe('transparent');
    expect(page.style.getPropertyValue('--kit-tab-bg')).toBe('transparent');
    expect(page.style.getPropertyValue('--kit-dialog-bg')).toBe('');
    expect(page.style.getPropertyValue('--kit-panel-bg')).toBe('');
  });

  it('leaves no mark and no variable of a kit once a theme without one is on', () => {
    applyKit(page, KIT, BASE);
    applyKit(page, null, BASE);
    expect(page.dataset.kit).toBeUndefined();
    expect(kitVariables()).toEqual([]);
  });

  it("takes away a slot the next theme's kit does not have", () => {
    applyKit(page, KIT, BASE);
    applyKit(page, { slots: { btn: KIT.slots.btn! } }, '/api/themes/files/other/2.0.0/');
    expect(kitVariables()).toEqual(['--kit-btn', '--kit-btn-bg', '--kit-btn-outset', '--kit-btn-slice', '--kit-btn-width']);
    expect(page.style.getPropertyValue('--kit-btn')).toBe('url("/api/themes/files/other/2.0.0/ui/kit/btn%402x.png")');
  });

  /* The server checks the kit when it takes the archive; the page checks it again, so no value of it can reach CSS as
     anything but a picture of the theme, a length or a colour. */
  it('skips a slot or colour that is not what a kit allows, and keeps the rest', () => {
    applyKit(page, {
      slots: {
        good: { file: 'good.png', width: '4px' },
        page: { file: 'bad.html' },
        moving: { file: 'bad.gif' },
        away: { file: '../look.json' },
        wide: { file: 'wide.png', width: 'url(https://example.com/x.png)' },
        sized: { file: 'sized.png', size: 'calc(100% - 20px) 5px' },
        'Bad Name': { file: 'name.png' },
      },
      colors: { ink: 'red', 'tab-ink': '#502704;color:red' },
    } as unknown as Kit, BASE);
    expect(kitVariables()).toEqual(['--kit-good', '--kit-good-width']);
  });

  it('puts on no kit whose pictures would come from anywhere but the theme files of the server', () => {
    for (const base of ['https://example.com/api/themes/files/x/1/', '/uploads/', '//example.com/api/themes/files/x/1/', '/api/themes/files/x/1/../../../']) {
      applyKit(page, KIT, base);
      expect(page.dataset.kit, base).toBeUndefined();
      expect(kitVariables(), base).toEqual([]);
    }
  });
});
