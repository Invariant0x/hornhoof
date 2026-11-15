import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Idents } from '../src/ui/Idents';
import { decl } from './css';

describe('addresses and names inside a sentence', () => {
  it('stands each one in its own box, left to right, and keeps the words around it as they are', () => {
    const { container } = render(<p><Idents text="Made by sheets-bot@acme.example for ivan@acme.example, and sheets-bot@acme.example again." idents={['sheets-bot@acme.example', 'ivan@acme.example', null]} /></p>);
    expect(container.textContent).toBe('Made by sheets-bot@acme.example for ivan@acme.example, and sheets-bot@acme.example again.');
    expect([...container.querySelectorAll('bdi.ident')].map(box => [box.textContent, box.getAttribute('dir')])).toEqual([
      ['sheets-bot@acme.example', 'ltr'],
      ['ivan@acme.example', 'ltr'],
      ['sheets-bot@acme.example', 'ltr'],
    ]);
  });

  it('leaves a sentence without any as plain text', () => {
    const { container } = render(<p><Idents text="Nothing saved." idents={['x@acme.example']} /></p>);
    expect(container.innerHTML).toBe('<p>Nothing saved.</p>');
  });

  /* A box moves to the next line whole where it fits a line of its own, and breaks only where it does not. */
  it('moves to the next line whole instead of breaking at a hyphen', () => {
    expect(decl('.ident', 'display')).toBe('inline-block');
    expect(decl('.ident', 'max-inline-size')).toBe('100%');
    expect(decl('.ident', 'overflow-wrap')).toBe('anywhere');
  });
});
