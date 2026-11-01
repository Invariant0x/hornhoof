import { describe, expect, it, vi } from 'vitest';
import { api, ApiFailure } from '../src/api';
import { detectLanguage, errorText, plural } from '../src/i18n';
import { en } from '../src/i18n/en';
import { ru } from '../src/i18n/ru';
import { mockApi } from './api-mock';

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

/* Every text in a language, with functions called on placeholder arguments. */
function textsOf(messages: unknown): string[] {
  const texts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') texts.push(v);
    else if (typeof v === 'function') texts.push(String((v as (...a: string[]) => unknown)('X', 'Y', 'Z')));
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(messages);
  return texts;
}

describe('Russian vocabulary', () => {
  it('calls them машина and нода everywhere', () => {
    expect(textsOf(ru).filter(t => /узел|узл|компьютер/i.test(t))).toEqual([]);
  });
});

describe('The agent in the center', () => {
  it('is the orchestrator in both languages, since the chief is the CEO', () => {
    expect(textsOf(en).filter(t => /chief/i.test(t))).toEqual([]);
    expect(textsOf(ru).filter(t => /шеф/i.test(t))).toEqual([]);
  });
});

describe('errorText', () => {
  it('shows a known reason in the chosen language', () => {
    expect(errorText(ru, new ApiFailure(401, 'unauthorized', 'Wrong email or password.', 'wrong_password'))).toBe(ru.errors.wrong_password);
  });

  it('tells a person who tried too often to wait, in both languages', () => {
    const err = new ApiFailure(429, 'too_many', 'Too many attempts. Wait up to 15 minutes, then try again.', 'too_many_attempts');
    /* A sign-in past the softer cap per email waits up to an hour. */
    expect(errorText(en, err)).toBe('Too many attempts. Wait up to an hour, then try again.');
    expect(errorText(ru, err)).toBe('Слишком много попыток. Подождите до часа и попробуйте снова.');
    expect(errorText(ru, new ApiFailure(429, 'too_many', 'x'))).toBe('Слишком много попыток. Подождите немного и попробуйте снова.');
  });

  it('words a failure the server did not word from the dictionary, in English too', async () => {
    mockApi({ 'GET /api/x': [503, { error: { code: 'unavailable' } }] });
    const silent = await api.get('/api/x').catch((err: unknown) => err);
    expect(errorText(en, silent)).toBe(en.errors.codes.unavailable);
    expect(errorText(ru, silent)).toBe(ru.errors.codes.unavailable);
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const unreachable = await api.get('/api/x').catch((err: unknown) => err);
    expect(errorText(en, unreachable)).toBe(en.errors.codes.network);
    expect(errorText(ru, unreachable)).toBe(ru.errors.codes.network);
  });

  it('falls back to the error code in Russian and to the server message in English', () => {
    const err = new ApiFailure(401, 'unauthorized', 'Some new server text.', 'not_a_reason_yet');
    expect(errorText(ru, err)).toBe(ru.errors.codes.unauthorized);
    expect(errorText(en, err)).toBe('Some new server text.');
  });
});
