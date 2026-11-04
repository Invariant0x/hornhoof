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

describe('company template headcount', () => {
  it('counts employees with the right Russian form', () => {
    expect([1, 2, 5, 11, 21].map(n => ru.companyTemplates.employees(n))).toEqual(['1 сотрудник', '2 сотрудника', '5 сотрудников', '11 сотрудников', '21 сотрудник']);
    expect([1, 2].map(n => en.companyTemplates.employees(n))).toEqual(['1 employee', '2 employees']);
  });
});

describe('Russian vocabulary', () => {
  it('calls them машина and нода everywhere', () => {
    expect(textsOf(ru).filter(t => /узел|узл|компьютер/i.test(t))).toEqual([]);
  });

  it('writes е without dots and uses no em dashes in either language', () => {
    expect(textsOf(ru).filter(t => /[\u0451\u0401]/.test(t))).toEqual([]);
    expect(textsOf(en).filter(t => t.includes('\u2014'))).toEqual([]);
    expect(textsOf(ru).filter(t => t.includes('\u2014'))).toEqual([]);
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

  it('words the reasons of maintenance, read-only and starting in both languages', () => {
    const answer = (reason: string) => new ApiFailure(503, 'unavailable', 'x', reason);
    expect(errorText(en, answer('maintenance'))).toBe('Hornhoof is installing an update and takes no changes until it ends. Try again in a few minutes.');
    expect(errorText(ru, answer('maintenance'))).toBe('Hornhoof ставит обновление и не принимает изменений, пока оно не закончится. Попробуйте через несколько минут.');
    expect(errorText(en, answer('read_only'))).toBe('Hornhoof only reads on this machine now, so nothing was changed.');
    expect(errorText(ru, answer('read_only'))).toBe('Сейчас Hornhoof на этой машине только читает, поэтому ничего не изменилось.');
    expect(errorText(en, answer('starting'))).toBe('Hornhoof is starting. Try again in a few seconds.');
    expect(errorText(ru, answer('starting'))).toBe('Hornhoof запускается. Попробуйте еще раз через несколько секунд.');
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

describe('work tree words', () => {
  it('uses the actual turn, branch and times in both languages', () => {
    for (const L of [en.dept.tree, ru.dept.tree]) {
      expect(L.treeAria(7)).toContain('7');
      expect(L.reviewH(7)).toContain('7');
      expect(L.mergeH(49, 'turn-7')).toContain('turn-7');
      expect(L.turnSay(7, '11:42', 'develop')).toContain('11:42');
      expect(L.turnSay(7, '11:42', 'develop')).toContain('develop');
      expect(L.spdSub(7, '11:42', '17:24')).toContain('17:24');
      expect(L.verdict(false, null)).not.toContain('null');
    }
  });

  it('counts findings in Russian and tasks in English', () => {
    expect([1, 2, 5, 11, 21].map(ru.dept.tree.found)).toEqual(['1 находка', '2 находки', '5 находок', '11 находок', '21 находка']);
    expect(en.dept.tree.inTurn(1, 1)).toBe('1 of 1 task');
  });
});
