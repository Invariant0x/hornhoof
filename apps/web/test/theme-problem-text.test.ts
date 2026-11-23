/* What the theme store says of an archive the server refused (docs/theme-archive.md, 10): the problem's own words with
   the file it is in, and what the check found there, in the person's language. */

import type { ThemeProblemCode } from '@hornhoof/protocol/themes';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { archiveProblemText } from '../src/themes/problem-text';

describe('the words for a refused archive', () => {
  it('names the file the problem is in', () => {
    expect(archiveProblemText(en, { code: 'file_script', path: 'ui/kit/run.js' })).toBe('ui/kit/run.js is a script, a page or a style sheet. A theme holds no code: remove it.');
  });

  it('says the archive is damaged when a problem has no words of its own', () => {
    expect(archiveProblemText(en, { code: 'no_such_problem' as ThemeProblemCode })).toBe('The archive is damaged. Pack the theme again.');
  });

  it('adds the place and the form the check gave, in brackets', () => {
    expect(archiveProblemText(en, { code: 'json_shape', path: 'ui/kit.json', detail: 'slots.btn.slice: 1 to 4 numbers' })).toBe(
      'ui/kit.json does not match the guide. Check its fields against the example. (slots.btn.slice: 1 to 4 numbers)',
    );
  });

  it("says what the skin check found in the look, in the person's language", () => {
    const detail = JSON.stringify(['bad_color', 'colors.bg', 'red']);
    expect(archiveProblemText(en, { code: 'look_bad', path: 'ui/look.json', detail })).toBe(
      'ui/look.json does not pass the skin check. The colors.bg field needs a color in #RRGGBB or rgba() format. Fix the field and add the file again.',
    );
    expect(archiveProblemText(ru, { code: 'look_bad', path: 'ui/look.json', detail })).toBe(
      `${ru.skins.archive.problems.look_bad('ui/look.json')} В поле colors.bg нужен цвет вида #RRGGBB или rgba(). Исправьте поле и добавьте файл снова.`,
    );
  });

  it('keeps to its first sentence when what the skin check found cannot be read', () => {
    expect(archiveProblemText(en, { code: 'look_bad', detail: 'not json' })).toBe('ui/look.json does not pass the skin check.');
  });

  it('gives what the skin check found as it is, in brackets, when the check names a problem it has no words for', () => {
    const detail = JSON.stringify(['no_such_code', 'colors.bg', 'red']);
    expect(archiveProblemText(en, { code: 'look_bad', detail })).toBe(`ui/look.json does not pass the skin check. (${detail})`);
  });
});
