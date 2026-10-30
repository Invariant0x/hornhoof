import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/ui/Markdown';

describe('Markdown', () => {
  it('shows bold and code the way a terminal does', () => {
    const { container } = render(<Markdown text={'Start with **Development** and run `npm test`.'} />);
    expect(screen.getByText('Development').tagName).toBe('STRONG');
    expect(screen.getByText('npm test').tagName).toBe('CODE');
    expect(container).toHaveTextContent('Start with Development and run npm test.');
  });

  it('turns dashes and numbers into lists and keeps paragraphs apart', () => {
    const { container } = render(<Markdown text={'Five departments:\n- **Operations**: tools\n- Sales\n\nNext:\n1. Staff\n2. Tasks\nThat is all.'} />);
    expect([...container.querySelectorAll('ul > li')].map(li => li.textContent)).toEqual(['Operations: tools', 'Sales']);
    expect([...container.querySelectorAll('ol > li')].map(li => li.textContent)).toEqual(['Staff', 'Tasks']);
    expect([...container.querySelectorAll('p')].map(p => p.textContent)).toEqual(['Five departments:', 'Next:', 'That is all.']);
  });

  it('keeps line breaks inside a paragraph', () => {
    const { container } = render(<Markdown text={'One\nTwo'} />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.querySelectorAll('p br')).toHaveLength(1);
  });

  it('never turns text into markup', () => {
    const { container } = render(<Markdown text={'<img src=x onerror=alert(1)> **<b>hi</b>**'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<img src=x onerror=alert(1)> <b>hi</b>');
  });
});
