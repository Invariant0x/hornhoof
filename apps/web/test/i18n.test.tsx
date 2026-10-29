import { describe, expect, it } from 'vitest';
import { ApiFailure } from '../src/api';
import { detectLanguage, errorText, plural } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';

describe('detectLanguage', () => {
  it('follows the browser until a language is saved', () => {
    expect(detectLanguage(null, ['ru-RU', 'en'])).toBe('ru');
    expect(detectLanguage(null, ['de-DE'])).toBe('en');
    expect(detectLanguage('en', ['ru'])).toBe('en');
    expect(detectLanguage('xx', ['ru'])).toBe('ru');
  });
});

describe('plural', () => {
  it('picks the Russian form by the number', () => {
    const forms = { one: 'команда', few: 'команды', many: 'команд', other: 'команды' };
    expect([1, 3, 5, 21].map(n => plural('ru', n, forms))).toEqual(['команда', 'команды', 'команд', 'команда']);
  });
});

describe('errorText', () => {
  it('shows a known reason in the chosen language', () => {
    expect(errorText(ru, new ApiFailure(401, 'unauthorized', 'Wrong email or password.', 'wrong_password'))).toBe(ru.errors.wrong_password);
  });

  it('falls back to the error code in Russian and to the server message in English', () => {
    const err = new ApiFailure(401, 'unauthorized', 'Some new server text.', 'not_a_reason_yet');
    expect(errorText(ru, err)).toBe(ru.errors.codes.unauthorized);
    expect(errorText(en, err)).toBe('Some new server text.');
  });
});
