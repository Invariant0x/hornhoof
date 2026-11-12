import { describe, expect, it } from 'vitest';
import { decl } from './css';

/* A canvas moved by dragging selects no text: a press, a drag or a double click on a card's words would otherwise mark them, and
   a browser's translator or search pops up over the map. */
describe('canvases moved by dragging', () => {
  it.each(['.map', '.dcanvas', '.tview .tv-scroll'])('%s selects no text', selector => {
    expect(decl(selector, 'user-select')).toBe('none');
    expect(decl(selector, '-webkit-user-select')).toBe('none');
  });
});
