import { afterEach, describe, expect, it } from 'vitest';
import { applyKit, type Kit } from '../src/skins/kit';

/* A theme's painted interface parts, from its ui/kit.json as #1960's store keeps it, put on the page as the CSS variables
   kit.css draws from (theme UI kit 1.0, sections 3 and 6.2). The pictures come only from the theme's files on the server;
   slot and colour names and the forms of their values are the protocol's, the same the server checks with. */

const page = document.documentElement;
const BASE = '/api/themes/files/sand-test/1.0.0/';
const kitVariables = () => [...page.style].filter(name => name.startsWith('--kit-')).sort();

const KIT: Kit = {
  slots: {
    dialog: { file: 'dialog.face@2x.webp', slice: '63 62 56 62 fill', width: '31.5px 31px 28px 31px', outset: '12.9px 11.2px 11.2px 11.2px', repeat: 'round' },
    btn: { file: 'btn@2x.png', slice: '10 fill', width: '5px', outset: '1px' },
    panel: { file: 'panel.weave@2x.webp', size: '128px 128px' },
    table: { file: 'table@2x.webp', slice: '34', width: '17px' },
    tab: { file: 'tab@2x.webp', slice: '12 fill', width: '6.5px' },
    'tab-on': { file: 'tab-on@2x.webp', size: 'calc(100% - 20px) 5px' },
  },
  colors: { 'tab-ink': '#502704' },
};

afterEach(() => applyKit(page, null, BASE));

describe('applyKit', () => {
  it("puts each slot's picture, slice, width, outset, repeat and size and each kit colour on the page, and marks it", () => {
    applyKit(page, KIT, BASE);
    expect(page.dataset.kit).toBe('on');
    expect(page.style.getPropertyValue('--kit-dialog')).toBe(`url("${BASE}ui/kit/dialog.face%402x.webp")`);
    expect(page.style.getPropertyValue('--kit-dialog-slice')).toBe('63 62 56 62 fill');
    expect(page.style.getPropertyValue('--kit-dialog-width')).toBe('31.5px 31px 28px 31px');
    expect(page.style.getPropertyValue('--kit-dialog-outset')).toBe('12.9px 11.2px 11.2px 11.2px');
    expect(page.style.getPropertyValue('--kit-dialog-repeat')).toBe('round');
    expect(page.style.getPropertyValue('--kit-btn-slice')).toBe('10 fill');
    expect(page.style.getPropertyValue('--kit-btn-outset')).toBe('1px');
    expect(page.style.getPropertyValue('--kit-panel-size')).toBe('128px 128px');
    expect(page.style.getPropertyValue('--kit-table-slice')).toBe('34');
    expect(page.style.getPropertyValue('--kit-tab-width')).toBe('6.5px');
    expect(page.style.getPropertyValue('--kit-tab-on-size')).toBe('calc(100% - 20px) 5px');
    expect(page.style.getPropertyValue('--kit-c-tab-ink')).toBe('#502704');
  });

  /* A plate whose painted middle is its face: the element's own fill steps aside. */
  it('clears the fill of an element whose slot paints its middle, names those slots as faces, and only those', () => {
    applyKit(page, KIT, BASE);
    expect(page.style.getPropertyValue('--kit-btn-bg')).toBe('transparent');
    expect(page.style.getPropertyValue('--kit-dialog-bg')).toBe('transparent');
    expect(page.style.getPropertyValue('--kit-table-bg')).toBe('');
    expect(page.style.getPropertyValue('--kit-panel-bg')).toBe('');
    expect(page.dataset.kitFaces?.split(' ').sort()).toEqual(['btn', 'dialog', 'tab']);
  });

  it('leaves no mark and no variable of a kit once a theme without one is on', () => {
    applyKit(page, KIT, BASE);
    applyKit(page, null, BASE);
    expect(page.dataset.kit).toBeUndefined();
    expect(page.dataset.kitFaces).toBeUndefined();
    expect(kitVariables()).toEqual([]);
  });

  it("takes away a slot the next theme's kit does not have", () => {
    applyKit(page, KIT, BASE);
    applyKit(page, { slots: { btn: KIT.slots.btn! } }, '/api/themes/files/other/2.0.0/');
    expect(kitVariables()).toEqual(['--kit-btn', '--kit-btn-bg', '--kit-btn-outset', '--kit-btn-slice', '--kit-btn-width']);
    expect(page.style.getPropertyValue('--kit-btn')).toBe('url("/api/themes/files/other/2.0.0/ui/kit/btn%402x.png")');
    expect(page.dataset.kitFaces).toBe('btn');
    applyKit(page, { slots: { table: KIT.slots.table! } }, BASE);
    expect(page.dataset.kitFaces).toBeUndefined();
  });

  /* The server checks the kit when it takes the archive; the page checks it again, so no value of it can reach CSS as
     anything but a picture of the theme, a length or a colour. */
  it('skips a slot, value or colour that is not what a kit allows, and keeps the rest', () => {
    applyKit(page, {
      slots: {
        btn: { file: 'btn@2x.png', width: '4px', size: 'url(https://example.com/x.png)', repeat: 'round round round' },
        good: { file: 'good.png' },
        dialog: { file: 'dialog.html' },
        menu: { file: 'menu.gif' },
        drawer: { file: '../look.json' },
        card: { file: 'Card@2x.png' },
        tab: { file: 'tab.svg' },
        tile: { file: 'tile.png', width: 'url(https://example.com/x.png)', outset: '1px;color:red', slice: '10 fill;x' },
        divider: { file: 'divider.png', width: `${'1'.repeat(118)}px`, outset: `${'1'.repeat(119)}px` },
        'Bad Name': { file: 'name.png' },
      },
      colors: { ink: '#502704', 'tab-ink': '#502704;color:red', 'badge-ink': 'red', 'danger-ink': '#6A1030' },
    } as unknown as Kit, BASE);
    expect(kitVariables()).toEqual(['--kit-btn', '--kit-btn-width', '--kit-c-danger-ink', '--kit-divider', '--kit-divider-width', '--kit-tile']);
    expect(page.dataset.kitFaces).toBeUndefined();
  });

  it('puts on no kit whose pictures would come from anywhere but the theme files of the server', () => {
    for (const base of ['https://example.com/api/themes/files/x/1/', '/uploads/', '//example.com/api/themes/files/x/1/', '/api/themes/files/x/1/../../../']) {
      applyKit(page, KIT, base);
      expect(page.dataset.kit, base).toBeUndefined();
      expect(kitVariables(), base).toEqual([]);
    }
  });
});
