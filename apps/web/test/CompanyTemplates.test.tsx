import { COMPANY_TEMPLATES } from '@hornhoof/protocol/catalog';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageProvider } from '../src/i18n';
import { en } from '../src/i18n/en';
import { CompanyTemplates, LINE_MAX, nameLines, Scheme, schemeLayout } from '../src/ui/CompanyTemplates';
import { RULES } from './css';

/* The lines of a name read back as the name: a line that ends a broken word joins the next one without its hyphen. */
const rejoined = (lines: string[]) => lines.reduce((text, line, i) => (i === 0 ? line : text.endsWith('-') && lines[i - 1]!.length === LINE_MAX ? `${text.slice(0, -1)}${line}` : `${text} ${line}`), '');
const linesOf = (text: Element) => [...text.querySelectorAll('tspan')].map(span => span.textContent ?? '');

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('the scheme on a company template card', () => {
  it('wraps a name at its spaces and cuts no word that fits a line', () => {
    expect(nameLines('Business development')).toEqual(['Business', 'development']);
    expect(nameLines('Домашнее хозяйство')).toEqual(['Домашнее', 'хозяйство']);
    expect(nameLines('Video production')).toEqual(['Video', 'production']);
    expect(nameLines('Sales')).toEqual(['Sales']);
  });

  it('breaks only a word longer than a whole line, with a hyphen, and leaves nothing out', () => {
    expect(nameLines('Видеопроизводство')).toEqual(['Видеопроиз-', 'водство']);
    for (const name of ['Видеопроизводство', 'Исследовательская лаборатория', 'Компания по кибербезопасности', 'A very long department name here']) {
      const lines = nameLines(name);
      expect(lines.join(''), name).not.toContain('…');
      for (const line of lines) expect(line.length, `${name}: ${line}`).toBeLessThanOrEqual(LINE_MAX);
      expect(rejoined(lines), name).toBe(name);
    }
  });

  it('grows a box by the lines of its name and the canvas by its rows', () => {
    const [short] = schemeLayout([{ name: 'Sales' }]).rows;
    const [tall] = schemeLayout([{ name: 'Sales' }, { name: 'A very long department name here' }]).rows;
    expect(short!.boxes[0]!.h).toBe(26);
    expect(nameLines('A very long department name here').length).toBeGreaterThan(2);
    /* The boxes of a row stand as high as its tallest one. */
    expect(tall!.boxes.map(box => box.h)).toEqual([tall!.boxes[1]!.h, tall!.boxes[1]!.h]);
    expect(tall!.boxes[1]!.h).toBeGreaterThan(26);
    const many = schemeLayout(Array.from({ length: 12 }, (_, i) => ({ name: `Department number ${i}` })));
    const last = many.rows.at(-1)!.boxes[0]!;
    expect(many.height).toBeGreaterThan(114);
    expect(many.height).toBeGreaterThanOrEqual(last.y + last.h);
  });

  it('draws every line of a long name inside its box', () => {
    const template = { key: 'project' as const, departments: [{ template: 'development' as const, name: 'A very long department name here', staff: [] }] };
    const { container } = render(<Scheme template={template} t={en} height={schemeLayout([{ name: template.departments[0]!.name }]).height} />);
    const rect = container.querySelector('rect.scheme-dept')!;
    const text = container.querySelector('text.scheme-name')!;
    expect(rejoined(linesOf(text))).toBe('A very long department name here');
    expect(Number(rect.getAttribute('height'))).toBeGreaterThan(26);
    const top = Number(rect.getAttribute('y')), bottom = top + Number(rect.getAttribute('height'));
    const first = Number(text.getAttribute('y')), last = first + (linesOf(text).length - 1) * 9;
    expect(first - 4).toBeGreaterThanOrEqual(top);
    expect(last + 4).toBeLessThanOrEqual(bottom);
  });

  it.each(['en', 'ru'])('shows every department name whole on every card, all cards with one scheme height, in %s', language => {
    localStorage.setItem('hh-lang', language);
    const { container } = render(<LanguageProvider><CompanyTemplates value="empty" onPick={() => {}} /></LanguageProvider>);
    const schemes = [...container.querySelectorAll('svg.scheme')];
    expect(schemes).toHaveLength(COMPANY_TEMPLATES.length + 1);
    expect(new Set(schemes.map(svg => svg.getAttribute('viewBox'))).size).toBe(1);
    const height = Number(schemes[0]!.getAttribute('viewBox')!.split(' ')[3]);
    for (const text of container.querySelectorAll('text.scheme-name')) {
      const lines = linesOf(text);
      expect(lines.join(''), text.querySelector('title')!.textContent!).not.toContain('…');
      expect(rejoined(lines)).toBe(text.querySelector('title')!.textContent);
    }
    for (const rect of container.querySelectorAll('rect')) expect(Number(rect.getAttribute('y')) + Number(rect.getAttribute('height'))).toBeLessThanOrEqual(height);
  });

  it('cuts nothing with the stylesheet either: no ellipsis, no hidden overflow and no fixed height on the cards and their schemes', () => {
    const own = RULES.filter(rule => rule.selectors.some(selector => /\.(?:scheme|template-)/.test(selector)));
    expect(own.length).toBeGreaterThan(0);
    for (const rule of own) {
      expect(rule.decls['text-overflow'], rule.selectors.join(', ')).toBeUndefined();
      expect(rule.decls.overflow ?? '', rule.selectors.join(', ')).not.toMatch(/hidden|clip/);
      /* The radio button of a card keeps its own size; the card and its scheme take the height of what they hold. */
      if (!rule.selectors.some(selector => selector.endsWith(' input'))) expect(rule.decls.height ?? 'auto', rule.selectors.join(', ')).toBe('auto');
    }
    expect(RULES.find(rule => rule.selectors.includes('.scheme'))!.decls['aspect-ratio']).toBe('280 / var(--scheme-h, 114)');
  });
});
